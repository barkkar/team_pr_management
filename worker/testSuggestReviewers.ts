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
import {
  claudeToolLoop,
  checkClaudeHealth,
  getClaudeModel,
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

const TOOLS: ClaudeTool[] = [
  { name: 'fetch_pr_files', description: 'Fetch changed files + PR author', input_schema: { type: 'object', properties: { pr_url: { type: 'string' } }, required: ['pr_url'] } },
  { name: 'fetch_pr_diff', description: 'Fetch unified diff', input_schema: { type: 'object', properties: { pr_url: { type: 'string' }, max_bytes: { type: 'number' } }, required: ['pr_url'] } },
  { name: 'get_past_reviewers', description: 'Past reviewers of these files', input_schema: { type: 'object', properties: { file_paths: { type: 'array', items: { type: 'string' } } }, required: ['file_paths'] } },
  { name: 'get_past_authors', description: 'Past authors of these files', input_schema: { type: 'object', properties: { file_paths: { type: 'array', items: { type: 'string' } } }, required: ['file_paths'] } },
];

const SYSTEM_PROMPT = `You are a reviewer recommender. Call fetch_pr_files first, then get_past_reviewers and get_past_authors on those files. Optionally call fetch_pr_diff. Return up to 5 suggestions as JSON: {"suggestions":[{"ghe_login":"...","reason":"..."}]}. Exclude the PR author.`;

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

  let cachedAuthor = '';

  const onToolCall = async (call: ClaudeToolCall): Promise<ClaudeToolResult> => {
    log(`tool: ${call.name} input=${JSON.stringify(call.input).substring(0, 200)}`);
    try {
      if (call.name === 'fetch_pr_files') {
        const { hostname, org, repo, prNumber } = parseUrl(call.input.pr_url);
        const token = requireTokenForHost(hostname);
        const filesResp = await axios.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/files?per_page=100`, { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }, timeout: 15000 });
        const prResp = await axios.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`, { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }, timeout: 15000 });
        cachedAuthor = prResp.data?.user?.login || '';
        const result = { file_paths: (filesResp.data || []).map((f: any) => f.filename), pr_author: cachedAuthor };
        log(`  -> ${result.file_paths.length} files, author=${cachedAuthor}`);
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
      if (call.name === 'get_past_reviewers') {
        const resp = await axios.post(`${HEROKU_API_URL}/api/past-reviewers`, { file_paths: call.input.file_paths || [], pr_author: cachedAuthor, top_k: 10 }, { headers: { 'X-Worker-API-Key': WORKER_API_KEY!, 'Content-Type': 'application/json' }, timeout: 20000 });
        log(`  -> ${(resp.data.reviewers || []).length} reviewers`);
        return { tool_use_id: call.id, content: JSON.stringify(resp.data.reviewers || []) };
      }
      if (call.name === 'get_past_authors') {
        const resp = await axios.post(`${HEROKU_API_URL}/api/past-authors`, { file_paths: call.input.file_paths || [], pr_author: cachedAuthor, top_k: 10 }, { headers: { 'X-Worker-API-Key': WORKER_API_KEY!, 'Content-Type': 'application/json' }, timeout: 20000 });
        log(`  -> ${(resp.data.authors || []).length} authors`);
        return { tool_use_id: call.id, content: JSON.stringify(resp.data.authors || []) };
      }
      return { tool_use_id: call.id, content: `Unknown tool: ${call.name}`, is_error: true };
    } catch (err: any) {
      log(`  !! tool error: ${err.message}`);
      return { tool_use_id: call.id, content: `Error: ${err.message}`, is_error: true };
    }
  };

  const result = await claudeToolLoop(SYSTEM_PROMPT, `PR URL: ${prUrl}\nSuggest up to 5 reviewers.`, TOOLS, {
    temperature: 0.2, maxTokens: 2048, maxIterations: 6, onToolCall,
  });

  log(`Claude made ${result.toolCalls.length} tool call(s), ${result.iterations} rounds`);
  log(`Final text:\n${result.finalText}`);

  if (shouldPost && channelId) {
    if (!SLACK_BOT_TOKEN) { console.error('SLACK_BOT_TOKEN needed for --post'); return; }
    const parsed = JSON.parse(result.finalText);
    await axios.post(`${HEROKU_API_URL}/api/pr-reviewers`, { pr_url: prUrl, channel_id: channelId, message_ts: '0', suggestions: parsed.suggestions || [] }, { headers: { 'X-Worker-API-Key': WORKER_API_KEY!, 'Content-Type': 'application/json' } });
    log('Posted to Slack via /api/pr-reviewers.');
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });

