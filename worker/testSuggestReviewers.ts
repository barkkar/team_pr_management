#!/usr/bin/env npx ts-node
/**
 * Test Suggest Reviewers
 *
 * Dry-run the tool-use reviewer-suggestion pipeline for a PR URL.
 *
 * Usage:
 *   npm run test-suggest-reviewers -- <pr-url>
 *   npm run test-suggest-reviewers -- <pr-url> --post --channel=C123
 */

import 'dotenv/config';
import axios from 'axios';
import { requireTokenForHost } from '../src/utils/gheTokenResolver';
import { fetchFileCommits, fetchPrReviews } from './prAnalyzer';
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
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

function log(msg: string): void { console.log(`[${new Date().toISOString()}] ${msg}`); }
function parseUrl(prUrl: string) {
  const m = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Unrecognised PR URL: ${prUrl}`);
  return { hostname: m[1], org: m[2], repo: m[3], prNumber: parseInt(m[4], 10) };
}

async function fetchChannelMembers(channelId: string): Promise<Array<{ ghe_login: string; slack_user_id: string; display_name: string | null }>> {
  const resp = await axios.post(
    `${HEROKU_API_URL}/api/channel-members`,
    { channel_id: channelId },
    { headers: { 'X-Worker-API-Key': WORKER_API_KEY!, 'Content-Type': 'application/json' }, timeout: 15000 },
  );
  return resp.data.members || [];
}

const TOOLS: ClaudeTool[] = [
  { name: 'fetch_pr_files', description: 'Fetch changed files + PR author', input_schema: { type: 'object', properties: { pr_url: { type: 'string' } }, required: ['pr_url'] } },
  { name: 'fetch_pr_diff', description: 'Fetch unified diff', input_schema: { type: 'object', properties: { pr_url: { type: 'string' }, max_bytes: { type: 'number' } }, required: ['pr_url'] } },
  {
    name: 'get_channel_members',
    description: 'Return the resolved Slack channel members with their GHE logins. ONLY GHE logins returned by this tool are eligible to suggest. Returns an empty list if the channel has no bootstrap data; in that case, return zero suggestions.',
    input_schema: { type: 'object', properties: { channel_id: { type: 'string' } }, required: ['channel_id'] },
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

async function main() {
  const prUrl = process.argv.find(a => a.startsWith('https://'));
  if (!prUrl) { console.error('Usage: npm run test-suggest-reviewers -- <pr-url> [--post --channel=C123]'); process.exit(1); }
  const shouldPost = process.argv.includes('--post');
  const channelArg = process.argv.find(a => a.startsWith('--channel='));
  const channelId = channelArg ? channelArg.split('=')[1] : '';

  if (!HEROKU_API_URL || !WORKER_API_KEY) { console.error('HEROKU_API_URL + WORKER_API_KEY required'); process.exit(1); }

  const health = await checkClaudeHealth();
  if (!health.ok) { console.error(`Claude not ready: ${health.error}`); process.exit(1); }
  log(`Claude model: ${getClaudeModel()}`);

  const onToolCall = async (call: ClaudeToolCall): Promise<ClaudeToolResult> => {
    log(`tool: ${call.name} input=${JSON.stringify(call.input).substring(0, 200)}`);
    try {
      if (call.name === 'fetch_pr_files') {
        const { hostname, org, repo, prNumber } = parseUrl(call.input.pr_url);
        const token = requireTokenForHost(hostname);
        const filesResp = await axios.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/files?per_page=100`, { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }, timeout: 15000 });
        const prResp = await axios.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`, { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }, timeout: 15000 });
        const author = prResp.data?.user?.login || '';
        const result = { file_paths: (filesResp.data || []).map((f: any) => f.filename), pr_author: author };
        log(`  -> ${result.file_paths.length} files, author=${author}`);
        return { tool_use_id: call.id, content: JSON.stringify(result) };
      }
      if (call.name === 'fetch_pr_diff') {
        const { hostname, org, repo, prNumber } = parseUrl(call.input.pr_url);
        const token = requireTokenForHost(hostname);
        const maxBytes = call.input.max_bytes || 60000;
        const resp = await axios.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`, { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3.diff' }, timeout: 30000 });
        const diff: string = resp.data || '';
        const truncated = diff.length <= maxBytes ? diff : diff.substring(0, maxBytes) + `\n...[truncated ${diff.length - maxBytes} bytes]`;
        log(`  -> diff ${truncated.length} bytes`);
        return { tool_use_id: call.id, content: truncated };
      }
      if (call.name === 'get_channel_members') {
        const members = await fetchChannelMembers(call.input.channel_id);
        log(`  -> ${members.length} members`);
        return { tool_use_id: call.id, content: JSON.stringify(members) };
      }
      if (call.name === 'get_file_history') {
        const { hostname, org, repo } = parseUrl(call.input.pr_url);
        const commits = await fetchFileCommits(hostname, org, repo, call.input.file_path, call.input.limit || 20);
        log(`  -> ${commits.length} commits for ${call.input.file_path}`);
        return { tool_use_id: call.id, content: JSON.stringify(commits) };
      }
      if (call.name === 'get_pr_reviewers') {
        const { hostname, org, repo } = parseUrl(call.input.pr_url);
        const reviews = await fetchPrReviews(hostname, org, repo, call.input.pr_number);
        log(`  -> ${reviews.length} reviews on PR #${call.input.pr_number}`);
        return { tool_use_id: call.id, content: JSON.stringify(reviews) };
      }
      return { tool_use_id: call.id, content: `Unknown tool: ${call.name}`, is_error: true };
    } catch (err: any) {
      log(`  !! tool error: ${err.message}`);
      return { tool_use_id: call.id, content: `Error: ${err.message}`, is_error: true };
    }
  };

  const result = await claudeToolLoop(SYSTEM_PROMPT, `PR URL: ${prUrl}\nSlack channel: ${channelId || '(none)'}\n\nSuggest up to 5 reviewers.`, TOOLS, {
    temperature: 0.2, maxTokens: 2048, maxIterations: 12, onToolCall,
  });

  log(`Claude made ${result.toolCalls.length} tool call(s), ${result.iterations} rounds`);
  log(`Final text:\n${result.finalText}`);

  if (shouldPost && channelId) {
    if (!SLACK_BOT_TOKEN) { console.error('SLACK_BOT_TOKEN needed for --post'); return; }
    const parsed = extractJsonFromClaudeText<{ suggestions?: { ghe_login: string; reason: string }[] }>(result.finalText);
    if (!parsed) { console.error('Could not extract JSON from Claude output; nothing posted.'); return; }

    let suggestions = (parsed.suggestions || [])
      .filter(s => s && typeof s.ghe_login === 'string' && s.ghe_login.trim().length > 0)
      .slice(0, 5);

    let notice: 'channel_not_bootstrapped' | undefined;
    const members = await fetchChannelMembers(channelId);
    if (members.length === 0) {
      if (suggestions.length > 0) log(`Channel ${channelId} has no bootstrap data; dropping ${suggestions.length} suggestion(s).`);
      suggestions = [];
      notice = 'channel_not_bootstrapped';
    } else {
      const allowed = new Set(members.map(m => m.ghe_login.toLowerCase()));
      const before = suggestions.length;
      suggestions = suggestions.filter(s => allowed.has(s.ghe_login.toLowerCase()));
      const dropped = before - suggestions.length;
      if (dropped > 0) log(`Dropped ${dropped} suggestion(s) not in channel members.`);
    }

    await axios.post(
      `${HEROKU_API_URL}/api/pr-reviewers`,
      { pr_url: prUrl, channel_id: channelId, message_ts: '0', suggestions, ...(notice ? { notice } : {}) },
      { headers: { 'X-Worker-API-Key': WORKER_API_KEY!, 'Content-Type': 'application/json' } },
    );
    log('Posted to Slack via /api/pr-reviewers.');
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
