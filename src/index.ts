import 'dotenv/config';
import * as http from 'http';
import { createApp } from './app';
import { notifyError } from './utils/errorNotifier';
import {
  getPRsNeedingStatusCheck, updatePRStatus, PRStatusUpdate,
  getDistinctRepos, upsertUserMapping,
  getUserMapping,
  claimPendingBootstrap, updateBootstrapResults,
  getChannelMembers,
  pool,
} from './db/client';
import type { BootstrapResult } from './types/channelBootstrap';

// Simple body parser for JSON
async function parseJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Validate worker API key
function validateApiKey(req: http.IncomingMessage): boolean {
  const apiKey = req.headers['x-worker-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  const expectedKey = process.env.WORKER_API_KEY;
  
  if (!expectedKey) {
    console.warn('WORKER_API_KEY not set - worker API disabled');
    return false;
  }
  
  return apiKey === expectedKey;
}

const SLACK_SECTION_LIMIT = 2900;
const VALID_BOOTSTRAP_STATUSES = new Set(['resolved', 'unresolved', 'pending'] as const);

function formatReviewerMessage(
  suggestions: { ghe_login: string; slack_user_id?: string | null; reason: string }[],
  prUrl: string,
): { text: string; blocks: any[] } {
  const blocks: any[] = [];

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: ':eyes: *Suggested reviewers for this PR*' },
  });

  if (!suggestions || suggestions.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No reviewer suggestions available yet._' },
    });
    const text = ':eyes: Suggested reviewers — none available';
    return { text, blocks };
  }

  const mentionList = suggestions.map(s =>
    s.slack_user_id ? `<@${s.slack_user_id}>` : `\`${s.ghe_login}\``,
  );
  const mentionStr = mentionList.length === 1
    ? mentionList[0]
    : mentionList.slice(0, -1).join(', ') + ' and ' + mentionList[mentionList.length - 1];

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `Hey ${mentionStr}, could you take a look at <${prUrl}|this PR>?` },
  });

  const reasonLines = suggestions.map(s => {
    const mention = s.slack_user_id ? `<@${s.slack_user_id}>` : `\`${s.ghe_login}\``;
    return `• ${mention} — ${s.reason}`;
  }).join('\n');

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: reasonLines.substring(0, SLACK_SECTION_LIMIT) }],
  });

  const text = `:eyes: Suggested reviewers — ${suggestions.length} suggestion(s)`;
  return { text, blocks };
}

async function main(): Promise<void> {
  // Validate required environment variables
  const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  if (!process.env.GHE_TOKEN && !process.env.GHE_TOKENS) {
    console.error('Missing required environment variable: GHE_TOKEN or GHE_TOKENS (at least one must be set)');
    process.exit(1);
  }

  const app = createApp();

  // Add Socket Mode connection event listeners BEFORE starting
  const socketModeClient = (app as any).receiver?.client;
  if (socketModeClient) {
    socketModeClient.on('connected', () => {
      console.log('[Socket Mode] Connected to Slack');
    });
    socketModeClient.on('disconnected', () => {
      console.log('[Socket Mode] Disconnected from Slack');
    });
    socketModeClient.on('reconnecting', () => {
      console.log('[Socket Mode] Reconnecting...');
    });
    socketModeClient.on('error', (error: Error) => {
      console.error('[Socket Mode] Error:', error.message);
      notifyError('SocketMode', error.message);
    });
    socketModeClient.on('unable_to_socket_mode_start', (error: Error) => {
      console.error('[Socket Mode] Unable to start:', error.message);
      notifyError('SocketMode', `Unable to start: ${error.message}`, 'fatal');
    });
    console.log('[Socket Mode] Event listeners registered');
  } else {
    console.warn('[Socket Mode] Could not access socket client for event listeners');
  }

  // Start the Slack app (Socket Mode - connects via WebSocket)
  await app.start();
  console.log('[Socket Mode] PR Review Reminder bot started');

  // Create HTTP server for health checks and worker API
  const port = parseInt(process.env.PORT || '3000', 10);
  const server = http.createServer(async (req, res) => {
    const url = req.url || '';
    const method = req.method || 'GET';

    // CORS headers for worker
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Worker-API-Key, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Health check endpoints
      if (url === '/health' || url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', app: 'pr-review-reminder' }));
        return;
      }

      // Worker API: Get PRs needing status check
      if (url === '/api/pending-prs' && method === 'GET') {
        if (!validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const prs = await getPRsNeedingStatusCheck();
        console.log(`[Worker API] Returning ${prs.length} PRs for status check`);
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prs }));
        return;
      }

      // Worker API: Update PR status
      if (url === '/api/pr-status' && method === 'POST') {
        if (!validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const body = await parseJsonBody(req);
        const results: PRStatusUpdate[] = body.results || [];

        if (!Array.isArray(results)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid request body: expected { results: [...] }' }));
          return;
        }

        let updated = 0;
        for (const result of results) {
          if (result.pr_url && typeof result.is_open === 'boolean' && typeof result.has_reviews === 'boolean') {
            await updatePRStatus(result.pr_url, result.is_open, result.has_reviews);
            updated++;
          }
        }

        console.log(`[Worker API] Updated status for ${updated} PRs`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ updated }));
        return;
      }

      // PRs needing reviewer suggestions: tracked in last 24h, not yet suggested
      if (url === '/api/prs-needing-reviewer-suggestions' && method === 'GET') {
        if (!validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const result = await pool.query(`
          SELECT pr_url, channel_id, message_ts, org, repo, pr_number
          FROM tracked_prs
          WHERE suggestions_sent = FALSE
            AND (is_open = TRUE OR is_open IS NULL)
            AND created_at > NOW() - INTERVAL '24 hours'
          ORDER BY created_at DESC
          LIMIT 10
        `);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prs: result.rows }));
        return;
      }

      // ========== AI Knowledge Base API Endpoints ==========

      // Get ALL tracked PRs (for full re-harvest)
      if (url === '/api/all-tracked-prs' && method === 'GET') {
        if (!validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const result = await pool.query(`
          SELECT DISTINCT pr_url, org, repo, pr_number, channel_id, message_ts
          FROM tracked_prs
          ORDER BY pr_number ASC
        `);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prs: result.rows }));
        return;
      }

      // Get distinct repos from tracked PRs
      if (url === '/api/distinct-repos' && method === 'GET') {
        if (!validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const repos = await getDistinctRepos();
        // Infer hostname from tracked_prs pr_url
        const reposWithHost = [];
        for (const r of repos) {
          const row = await pool.query(
            'SELECT pr_url FROM tracked_prs WHERE org = $1 AND repo = $2 LIMIT 1',
            [r.org, r.repo],
          );
          const prUrl = row.rows[0]?.pr_url || '';
          const hostMatch = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)/);
          reposWithHost.push({ ...r, hostname: hostMatch ? hostMatch[1] : '' });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ repos: reposWithHost }));
        return;
      }

      // Receive user mappings
      if (url === '/api/user-mappings' && method === 'POST') {
        if (!validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const body = await parseJsonBody(req);
        let count = 0;

        for (const mapping of (body.mappings || [])) {
          await upsertUserMapping(mapping);
          count++;
        }

        console.log(`[Worker API] Upserted ${count} user mappings`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ count }));
        return;
      }

      // Receive reviewer suggestions from worker and post to Slack
      if (url === '/api/pr-reviewers' && method === 'POST') {
        if (!validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const body = await parseJsonBody(req);
        const { pr_url, channel_id, message_ts, suggestions, notice } = body;

        if (!pr_url || !Array.isArray(suggestions)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'pr_url and suggestions[] are required' }));
          return;
        }

        // Resolve Slack IDs and keep only users we can @-mention
        const resolved: { ghe_login: string; slack_user_id?: string | null; reason: string }[] = [];
        for (const s of suggestions as { ghe_login: string; reason: string }[]) {
          const mapping = await getUserMapping(s.ghe_login);
          if (!mapping?.slack_user_id) continue;
          resolved.push({
            ghe_login: s.ghe_login,
            slack_user_id: mapping.slack_user_id,
            reason: s.reason || 'familiar with this area of the codebase',
          });
        }

        // Mark the PR so we don't re-suggest
        await pool.query(
          'UPDATE tracked_prs SET suggestions_sent = TRUE WHERE pr_url = $1',
          [pr_url],
        );

        // Post Slack thread reply
        if (channel_id && channel_id !== 'manual' && message_ts && message_ts !== '0') {
          try {
            const slackMessage = (notice === 'channel_not_bootstrapped' && resolved.length === 0)
              ? {
                  text: ':warning: Channel onboarding not yet complete.',
                  blocks: [{
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: ":warning: This channel hasn't completed onboarding yet. Run `/pr-monitor add` (or wait for the next bootstrap pass) so reviewer suggestions can be scoped to channel members.",
                    },
                  }],
                }
              : formatReviewerMessage(resolved, pr_url);
            await app.client.chat.postMessage({
              channel: channel_id,
              thread_ts: message_ts,
              text: slackMessage.text,
              blocks: slackMessage.blocks,
              unfurl_links: false,
            });
            console.log(`[Worker API] Posted reviewer suggestions to ${channel_id}`);
          } catch (slackError: any) {
            console.error(`[Worker API] Failed Slack post: ${slackError.message}`);
            notifyError('WorkerAPI', `Failed to post reviewer suggestions: ${slackError.message}`);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, resolved_count: resolved.length }));
        return;
      }













      // Bootstrap claim: worker pulls up to N pending bootstrap rows
      if (url === '/api/bootstrap-claim' && method === 'POST') {
        if (!validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const body = await parseJsonBody(req);

        if (body.limit !== undefined && (typeof body.limit !== 'number' || !Number.isFinite(body.limit))) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'limit must be a number' }));
          return;
        }

        const rawLimit = body.limit === undefined ? 50 : body.limit;
        const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 50);

        const rows = await claimPendingBootstrap(limit);
        console.log(`[bootstrap-claim] returned ${rows.length} rows`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ rows }));
        return;
      }

      // Bootstrap complete: worker posts back per-row resolution results
      if (url === '/api/bootstrap-complete' && method === 'POST') {
        if (!validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const body = await parseJsonBody(req);

        if (!Array.isArray(body.results)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'results must be an array' }));
          return;
        }

        const results: BootstrapResult[] = body.results;

        for (let i = 0; i < results.length; i++) {
          const entry: any = results[i];
          if (
            !entry ||
            typeof entry.id !== 'number' ||
            !VALID_BOOTSTRAP_STATUSES.has(entry.status)
          ) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `invalid result entry at index ${i}` }));
            return;
          }

          if (entry.status === 'resolved') {
            if (
              typeof entry.ghe_login !== 'string' ||
              entry.ghe_login.length === 0 ||
              typeof entry.email !== 'string' ||
              entry.email.length === 0 ||
              typeof entry.slack_user_id !== 'string' ||
              entry.slack_user_id.length === 0 ||
              !(entry.display_name === null || typeof entry.display_name === 'string')
            ) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `invalid resolved entry at index ${i}` }));
              return;
            }
          } else if (entry.status === 'pending') {
            if (entry.attempts_delta !== 1 || typeof entry.last_error !== 'string') {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `invalid pending entry at index ${i}` }));
              return;
            }
          }
        }

        await updateBootstrapResults(results);

        let resolvedCount = 0;
        let unresolvedCount = 0;
        let pendingCount = 0;
        for (const entry of results) {
          if (entry.status === 'resolved') resolvedCount++;
          else if (entry.status === 'unresolved') unresolvedCount++;
          else if (entry.status === 'pending') pendingCount++;
        }

        console.log(
          `[bootstrap-complete] applied ${results.length} results (${resolvedCount} resolved, ${unresolvedCount} unresolved, ${pendingCount} pending)`,
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, updated: results.length }));
        return;
      }

      if (url === '/api/channel-members' && method === 'POST') {
        if (!validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const body = await parseJsonBody(req);
        const channelId = body.channel_id;

        if (typeof channelId !== 'string' || channelId.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'channel_id is required' }));
          return;
        }

        const members = await getChannelMembers(channelId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ members }));
        return;
      }

      // Not found
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));

    } catch (error: any) {
      console.error('API error:', error);
      notifyError('HTTPServer', error.message || 'Internal Server Error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'Internal Server Error' }));
    }
  });

  server.listen(port, () => {
    console.log(`HTTP server listening on port ${port}`);
    console.log(`  - Health check: GET /health`);
    console.log(`  - Worker API: GET /api/pending-prs, POST /api/pr-status`);
    console.log(`  - Reviewer API: /api/pending-prs, /api/pr-status, /api/pr-reviewers, /api/prs-needing-reviewer-suggestions`);
  });
}

main().catch(async (error) => {
  console.error('Failed to start app:', error);
  await notifyError('Server', `Failed to start: ${error.message || error}`, 'fatal');
  process.exit(1);
});
