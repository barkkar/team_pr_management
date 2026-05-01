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
 *   - get_past_reviewers(file_paths): top-K GHE logins who reviewed similar files
 *   - get_past_authors(file_paths): top-K GHE logins who authored similar files
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

async function toolGetPastReviewers(filePaths: string[], prAuthor: string): Promise<any[]> {
  const resp = await axios.post(
    `${HEROKU_API_URL}/api/past-reviewers`,
    { file_paths: filePaths, pr_author: prAuthor, top_k: 10 },
    { headers: herokuHeaders(), timeout: 20000 },
  );
  return resp.data.reviewers || [];
}

async function toolGetPastAuthors(filePaths: string[], prAuthor: string): Promise<any[]> {
  const resp = await axios.post(
    `${HEROKU_API_URL}/api/past-authors`,
    { file_paths: filePaths, pr_author: prAuthor, top_k: 10 },
    { headers: herokuHeaders(), timeout: 20000 },
  );
  return resp.data.authors || [];
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
    name: 'get_past_reviewers',
    description: 'Return GHE logins who have previously reviewed the given files (exact path or same directory). Each entry: { ghe_login, review_count, files[] }.',
    input_schema: {
      type: 'object',
      properties: { file_paths: { type: 'array', items: { type: 'string' } } },
      required: ['file_paths'],
    },
  },
  {
    name: 'get_past_authors',
    description: 'Return GHE logins who have previously authored changes to the given files. Each entry: { ghe_login, change_count, files[] }.',
    input_schema: {
      type: 'object',
      properties: { file_paths: { type: 'array', items: { type: 'string' } } },
      required: ['file_paths'],
    },
  },
];

// ---------------------------------------------------------------------------
// Main: suggestReviewers
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a reviewer recommender for a software team. Given a pull request URL, you choose up to 5 suggested reviewers from the team's history.

Procedure:
1. Call fetch_pr_files to get the changed file list and PR author.
2. Call get_past_reviewers and get_past_authors with those file paths to build a candidate pool.
3. Optionally call fetch_pr_diff if the file names alone are insufficient to judge reviewer fit. Keep diff fetches minimal.
4. Exclude the PR author. Prefer candidates who both reviewed and authored related code.
5. Return up to 5 suggestions, ordered best-first, with a short human-readable reason per candidate.

CRITICAL OUTPUT FORMAT — the FINAL assistant message MUST be ONLY a raw JSON object starting with { and ending with }. No markdown fences. No prose before or after. No code blocks. Just the JSON object itself:
{"suggestions":[{"ghe_login":"...","reason":"<one short sentence>"}]}`;

function buildUserPrompt(prUrl: string, channelId: string): string {
  return `PR URL: ${prUrl}\nSlack channel: ${channelId}\n\nSuggest up to 5 reviewers.`;
}

async function suggestReviewers(prUrl: string, channelId: string, messageTs: string): Promise<void> {
  log(`Processing ${prUrl}`);

  // Pre-parse to fail fast if URL is malformed
  parsePrUrl(prUrl);

  // Track cached author for the tool handlers (populated by fetch_pr_files)
  let cachedAuthor = '';

  const onToolCall = async (call: ClaudeToolCall): Promise<ClaudeToolResult> => {
    log(`  tool: ${call.name}`);
    try {
      if (call.name === 'fetch_pr_files') {
        const { pr_url } = call.input;
        const result = await toolFetchPrFiles(pr_url);
        cachedAuthor = result.pr_author;
        return { tool_use_id: call.id, content: JSON.stringify(result) };
      }
      if (call.name === 'fetch_pr_diff') {
        const { pr_url, max_bytes } = call.input;
        const diff = await toolFetchPrDiff(pr_url, max_bytes);
        return { tool_use_id: call.id, content: diff };
      }
      if (call.name === 'get_past_reviewers') {
        const { file_paths } = call.input;
        const rows = await toolGetPastReviewers(file_paths || [], cachedAuthor);
        return { tool_use_id: call.id, content: JSON.stringify(rows) };
      }
      if (call.name === 'get_past_authors') {
        const { file_paths } = call.input;
        const rows = await toolGetPastAuthors(file_paths || [], cachedAuthor);
        return { tool_use_id: call.id, content: JSON.stringify(rows) };
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

async function runLoop(): Promise<void> {
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
  await runLoop();
}

run().then(() => process.exit(0)).catch((err: any) => {
  logError(`Fatal: ${err.message}`);
  process.exit(1);
});
