#!/usr/bin/env npx ts-node
/**
 * PR Analyzer — Reviewer Suggestions (tool-use)
 *
 * For a newly tracked PR this worker invokes Claude with four tools and lets
 * Claude decide what PR context to fetch. The worker executes the tools
 * against GHE and Postgres; Claude returns a ranked reviewer list as JSON.
 *
 * Tools:
 *   - fetch_pr_files(pr_url): returns list of changed file paths
 *   - fetch_pr_diff(pr_url, max_bytes?): returns unified diff text (truncated)
 *   - get_channel_members(channel_id): resolved channel members with GHE logins
 *   - get_file_history(pr_url, file_path, limit?): recent commits touching a file
 *   - get_pr_reviewers(pr_url, pr_number): reviewers of a specific PR
 *
 * Usage:
 *   npm run suggest-reviewers -- https://gitcore.soma.salesforce.com/org/repo/pull/42
 *   (or the polling loop picks PRs from /api/prs-needing-reviewer-suggestions)
 */

import 'dotenv/config';
import axios from 'axios';
import { notifyError } from '../src/utils/errorNotifier';
import { requireTokenForHost } from '../src/utils/gheTokenResolver';
import {
  claudeToolLoop,
  checkClaudeHealth,
  getClaudeModel,
  extractJsonFromClaudeText,
  ClaudeTool,
  ClaudeToolCall,
  ClaudeToolResult,
} from '../src/services/claudeClient';

const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;

const DIFF_MAX_BYTES_DEFAULT = 60000;
const TOOL_CALL_CAP = 6;

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [PRAnalyzer] ${message}`);
}

function logError(message: string, severity: 'warn' | 'error' | 'fatal' = 'error'): void {
  console.error(`[${new Date().toISOString()}] [PRAnalyzer] ${message}`);
  notifyError('PRAnalyzer', message, severity);
}

function herokuHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Worker-API-Key': WORKER_API_KEY!,
  };
}

interface ParsedPrUrl {
  hostname: string;
  org: string;
  repo: string;
  prNumber: number;
}

function parsePrUrl(prUrl: string): ParsedPrUrl {
  const m = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Unrecognised PR URL: ${prUrl}`);
  return { hostname: m[1], org: m[2], repo: m[3], prNumber: parseInt(m[4], 10) };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolFetchPrFiles(prUrl: string): Promise<{ file_paths: string[]; pr_author: string }> {
  const { hostname, org, repo, prNumber } = parsePrUrl(prUrl);
  const token = requireTokenForHost(hostname);
  const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };

  // Paginate to get every file. Safety cap at 10 pages (1000 files).
  const allFiles: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const resp = await axios.get(
      `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      { headers, timeout: 15000 },
    );
    const batch: string[] = (resp.data || []).map((f: any) => f.filename).filter(Boolean);
    allFiles.push(...batch);
    if (batch.length < 100) break;
  }

  const prResp = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`,
    { headers, timeout: 15000 },
  );
  const prAuthor = prResp.data?.user?.login || '';

  return { file_paths: allFiles, pr_author: prAuthor };
}

async function toolFetchPrDiff(prUrl: string, maxBytes = DIFF_MAX_BYTES_DEFAULT): Promise<string> {
  const { hostname, org, repo, prNumber } = parsePrUrl(prUrl);
  const token = requireTokenForHost(hostname);
  const resp = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`,
    {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3.diff' },
      timeout: 30000,
    },
  );
  const diff: string = resp.data || '';
  if (diff.length <= maxBytes) return diff;
  return diff.substring(0, maxBytes) + `\n...[truncated: ${diff.length - maxBytes} bytes omitted]`;
}

export async function fetchFileCommits(
  host: string,
  org: string,
  repo: string,
  filePath: string,
  limit = 20,
): Promise<Array<{ sha: string; author_login: string | null; date: string; message: string }>> {
  const token = requireTokenForHost(host);
  const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };
  const resp = await axios.get(
    `https://${host}/api/v3/repos/${org}/${repo}/commits?path=${encodeURIComponent(filePath)}&per_page=${limit}`,
    { headers, timeout: 15000 },
  );
  return (resp.data || []).map((c: any) => ({
    sha: c.sha,
    author_login: c.author?.login ?? null,
    date: c.commit?.author?.date || '',
    message: c.commit?.message || '',
  }));
}

export async function fetchPrReviews(
  host: string,
  org: string,
  repo: string,
  prNumber: number,
): Promise<Array<{ user_login: string; state: string; submitted_at: string }>> {
  const token = requireTokenForHost(host);
  const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };
  const resp = await axios.get(
    `https://${host}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/reviews?per_page=100`,
    { headers, timeout: 15000 },
  );
  return (resp.data || [])
    .filter((r: any) => r.user && r.state !== 'DISMISSED')
    .map((r: any) => ({
      user_login: r.user.login,
      state: r.state,
      submitted_at: r.submitted_at || '',
    }));
}

async function toolGetChannelMembers(channelId: string): Promise<Array<{ ghe_login: string; slack_user_id: string; display_name: string | null }>> {
  const resp = await axios.post(
    `${HEROKU_API_URL}/api/channel-members`,
    { channel_id: channelId },
    { headers: herokuHeaders(), timeout: 15000 },
  );
  return resp.data.members || [];
}

async function toolGetFileHistory(prUrl: string, filePath: string, limit = 20) {
  const { hostname, org, repo } = parsePrUrl(prUrl);
  return fetchFileCommits(hostname, org, repo, filePath, limit);
}

async function toolGetPrReviewers(prUrl: string, prNumber: number) {
  const { hostname, org, repo } = parsePrUrl(prUrl);
  return fetchPrReviews(hostname, org, repo, prNumber);
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const TOOLS: ClaudeTool[] = [
  {
    name: 'fetch_pr_files',
    description: 'Fetch the list of files changed in the given PR and the PR author login. Call this first.',
    input_schema: {
      type: 'object',
      properties: { pr_url: { type: 'string' } },
      required: ['pr_url'],
    },
  },
  {
    name: 'fetch_pr_diff',
    description: 'Fetch the unified diff for the PR. Optional — call only if the file list is insufficient to judge reviewer fit.',
    input_schema: {
      type: 'object',
      properties: {
        pr_url: { type: 'string' },
        max_bytes: { type: 'number', description: 'Cap on diff size. Default 60000.' },
      },
      required: ['pr_url'],
    },
  },
  {
    name: 'get_channel_members',
    description: 'Return the resolved Slack channel members with their GHE logins. ONLY GHE logins returned by this tool are eligible to suggest. Returns an empty list if the channel has no bootstrap data; in that case, return zero suggestions.',
    input_schema: {
      type: 'object',
      properties: { channel_id: { type: 'string' } },
      required: ['channel_id'],
    },
  },
  {
    name: 'get_file_history',
    description: 'Fetch up to N most recent commits touching a single file in the PR\'s repo. Each entry: { sha, author_login, date, message }. author_login may be null when the commit is by an unmatched email.',
    input_schema: {
      type: 'object',
      properties: {
        pr_url: { type: 'string' },
        file_path: { type: 'string' },
        limit: { type: 'number', description: 'Default 20, max 50.' },
      },
      required: ['pr_url', 'file_path'],
    },
  },
  {
    name: 'get_pr_reviewers',
    description: 'Fetch reviewers of a specific PR (typically a PR discovered via get_file_history). Each entry: { user_login, state, submitted_at }. state ∈ APPROVED | CHANGES_REQUESTED | COMMENTED.',
    input_schema: {
      type: 'object',
      properties: {
        pr_url: { type: 'string', description: 'A PR URL in the same repo (used to derive host/org/repo).' },
        pr_number: { type: 'number' },
      },
      required: ['pr_url', 'pr_number'],
    },
  },
];

// ---------------------------------------------------------------------------
// Main: suggestReviewers
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a reviewer recommender for a software team. Given a pull request URL and a Slack channel, suggest up to 5 reviewers who are members of that channel.

Procedure:
1. Call get_channel_members FIRST. The GHE logins it returns are the ONLY eligible candidates. If it returns an empty list, return an empty suggestions array — do not suggest non-members.
2. Call fetch_pr_files to get the changed files and PR author.
3. For each changed file (up to ~5 most relevant), call get_file_history to find recent commits. Note the commit authors and the PRs those commits came from when visible in the message.
4. For PRs that look topically related, call get_pr_reviewers to see who reviewed them. Aggregate review counts across files and PRs.
5. Optionally call fetch_pr_diff if file names alone aren't enough to judge fit.
6. Exclude the PR author. Rank by recency + frequency among channel members. Return up to 5 best-fit reviewers.

CRITICAL: Every ghe_login in your output MUST be in the list returned by get_channel_members. If you cannot find 5 channel members with file history, return fewer (or zero). Never invent or guess logins.

CRITICAL OUTPUT FORMAT — the FINAL assistant message MUST be ONLY a raw JSON object starting with { and ending with }. No markdown fences. No prose before or after. No code blocks. Just the JSON object itself:
{"suggestions":[{"ghe_login":"...","reason":"<one short sentence>"}]}`;

function buildUserPrompt(prUrl: string, channelId: string): string {
  return `PR URL: ${prUrl}\nSlack channel: ${channelId}\n\nSuggest up to 5 reviewers.`;
}

async function suggestReviewers(prUrl: string, channelId: string, messageTs: string): Promise<void> {
  log(`Processing ${prUrl}`);

  // Pre-parse to fail fast if URL is malformed
  parsePrUrl(prUrl);

  const onToolCall = async (call: ClaudeToolCall): Promise<ClaudeToolResult> => {
    log(`  tool: ${call.name}`);
    try {
      if (call.name === 'fetch_pr_files') {
        const { pr_url } = call.input;
        const result = await toolFetchPrFiles(pr_url);
        return { tool_use_id: call.id, content: JSON.stringify(result) };
      }
      if (call.name === 'fetch_pr_diff') {
        const { pr_url, max_bytes } = call.input;
        const diff = await toolFetchPrDiff(pr_url, max_bytes);
        return { tool_use_id: call.id, content: diff };
      }
      if (call.name === 'get_channel_members') {
        const { channel_id } = call.input;
        const members = await toolGetChannelMembers(channel_id);
        return { tool_use_id: call.id, content: JSON.stringify(members) };
      }
      if (call.name === 'get_file_history') {
        const { pr_url, file_path, limit } = call.input;
        const commits = await toolGetFileHistory(pr_url, file_path, limit);
        return { tool_use_id: call.id, content: JSON.stringify(commits) };
      }
      if (call.name === 'get_pr_reviewers') {
        const { pr_url, pr_number } = call.input;
        const reviews = await toolGetPrReviewers(pr_url, pr_number);
        return { tool_use_id: call.id, content: JSON.stringify(reviews) };
      }
      return { tool_use_id: call.id, content: `Unknown tool: ${call.name}`, is_error: true };
    } catch (err: any) {
      log(`  tool error (${call.name}): ${err.message}`);
      return { tool_use_id: call.id, content: `Error: ${err.message}`, is_error: true };
    }
  };

  const result = await claudeToolLoop(SYSTEM_PROMPT, buildUserPrompt(prUrl, channelId), TOOLS, {
    temperature: 0.2,
    maxTokens: 2048,
    maxIterations: TOOL_CALL_CAP,
    onToolCall,
  });

  log(`  Claude made ${result.toolCalls.length} tool call(s) over ${result.iterations} round(s)`);

  // Parse JSON — handles plain JSON, ```json fences, and prose+JSON.
  // On failure, fall back to empty suggestions and still report, which marks
  // suggestions_sent=TRUE so we don't loop forever on a bad response.
  let suggestions: { ghe_login: string; reason: string }[] = [];
  const parsed = extractJsonFromClaudeText<{ suggestions?: { ghe_login: string; reason: string }[] }>(result.finalText);
  if (parsed && Array.isArray(parsed.suggestions)) {
    suggestions = parsed.suggestions;
  } else {
    logError(`  Failed to extract JSON from Claude output. Raw: ${result.finalText.substring(0, 300)}`);
    // Fall through to POST with empty suggestions — keeps the PR from being retried forever.
  }

  suggestions = suggestions
    .filter(s => s && typeof s.ghe_login === 'string' && s.ghe_login.trim().length > 0)
    .slice(0, 5);

  let notice: 'channel_not_bootstrapped' | undefined;
  const members = await toolGetChannelMembers(channelId);
  if (members.length === 0) {
    if (suggestions.length > 0) {
      log(`  Channel ${channelId} has no bootstrap data; dropping ${suggestions.length} suggestion(s).`);
    }
    suggestions = [];
    notice = 'channel_not_bootstrapped';
  } else {
    const allowed = new Set(members.map(m => m.ghe_login.toLowerCase()));
    const before = suggestions.length;
    suggestions = suggestions.filter(s => allowed.has(s.ghe_login.toLowerCase()));
    const dropped = before - suggestions.length;
    if (dropped > 0) log(`  Dropped ${dropped} suggestion(s) not in channel members.`);
  }

  log(`  Claude returned ${suggestions.length} suggestion(s)`);

  // Report to Heroku: stores the list and triggers Slack thread reply
  try {
    await axios.post(
      `${HEROKU_API_URL}/api/pr-reviewers`,
      {
        pr_url: prUrl,
        channel_id: channelId,
        message_ts: messageTs,
        suggestions,
        ...(notice ? { notice } : {}),
      },
      { headers: herokuHeaders(), timeout: 30000 },
    );
    log('  ✅ Reviewer suggestions reported.');
  } catch (err: any) {
    logError(`  Failed to report results: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Polling mode
// ---------------------------------------------------------------------------

async function fetchPrsNeedingSuggestions(): Promise<any[]> {
  const resp = await axios.get(`${HEROKU_API_URL}/api/prs-needing-reviewer-suggestions`, {
    headers: herokuHeaders(),
    timeout: 30000,
  });
  return resp.data.prs || [];
}

/**
 * One-shot polling pass: fetch PRs needing reviewer suggestions from Heroku,
 * run the tool-loop for each. Safe to call from other workers — errors on a
 * single PR are logged and swallowed so the caller isn't disrupted.
 */
export async function runSuggestReviewersLoop(): Promise<void> {
  log('Checking for PRs needing reviewer suggestions...');
  const prs = await fetchPrsNeedingSuggestions();
  if (prs.length === 0) {
    log('None.');
    return;
  }
  log(`Found ${prs.length} PR(s) needing suggestions.`);
  for (const pr of prs) {
    try {
      await suggestReviewers(pr.pr_url, pr.channel_id, pr.message_ts);
    } catch (e: any) {
      logError(`Failed for ${pr.pr_url}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  log('='.repeat(60));
  log('PR Analyzer (reviewer suggestions) starting...');
  log('='.repeat(60));

  if (!HEROKU_API_URL || !WORKER_API_KEY) {
    logError('HEROKU_API_URL and WORKER_API_KEY are required');
    process.exit(1);
  }
  if (!process.env.GHE_TOKEN && !process.env.GHE_TOKENS) {
    logError('GHE_TOKEN or GHE_TOKENS is required');
    process.exit(1);
  }

  const health = await checkClaudeHealth();
  if (!health.ok) {
    logError(`Claude not ready: ${health.error || 'unknown'}`);
    process.exit(1);
  }
  log(`Claude AI model ready: ${getClaudeModel()}`);

  const prUrlArg = process.argv.find(a => a.startsWith('https://'));
  if (prUrlArg) {
    await suggestReviewers(prUrlArg, 'manual', '0');
    return;
  }
  await runSuggestReviewersLoop();
}

// Only run as a standalone script when executed directly (not when imported
// as a module by another worker such as localPRChecker).
if (require.main === module) {
  run().then(() => process.exit(0)).catch((err: any) => {
    logError(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
