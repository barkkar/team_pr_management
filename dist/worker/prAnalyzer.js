#!/usr/bin/env npx ts-node
"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSuggestReviewersLoop = runSuggestReviewersLoop;
require("dotenv/config");
const axios_1 = __importDefault(require("axios"));
const errorNotifier_1 = require("../src/utils/errorNotifier");
const gheTokenResolver_1 = require("../src/utils/gheTokenResolver");
const claudeClient_1 = require("../src/services/claudeClient");
const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const DIFF_MAX_BYTES_DEFAULT = 60000;
const TOOL_CALL_CAP = 6;
function log(message) {
    console.log(`[${new Date().toISOString()}] [PRAnalyzer] ${message}`);
}
function logError(message, severity = 'error') {
    console.error(`[${new Date().toISOString()}] [PRAnalyzer] ${message}`);
    (0, errorNotifier_1.notifyError)('PRAnalyzer', message, severity);
}
function herokuHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-Worker-API-Key': WORKER_API_KEY,
    };
}
function parsePrUrl(prUrl) {
    const m = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
    if (!m)
        throw new Error(`Unrecognised PR URL: ${prUrl}`);
    return { hostname: m[1], org: m[2], repo: m[3], prNumber: parseInt(m[4], 10) };
}
// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------
async function toolFetchPrFiles(prUrl) {
    const { hostname, org, repo, prNumber } = parsePrUrl(prUrl);
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };
    // Paginate to get every file. Safety cap at 10 pages (1000 files).
    const allFiles = [];
    for (let page = 1; page <= 10; page++) {
        const resp = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`, { headers, timeout: 15000 });
        const batch = (resp.data || []).map((f) => f.filename).filter(Boolean);
        allFiles.push(...batch);
        if (batch.length < 100)
            break;
    }
    const prResp = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`, { headers, timeout: 15000 });
    const prAuthor = prResp.data?.user?.login || '';
    return { file_paths: allFiles, pr_author: prAuthor };
}
async function toolFetchPrDiff(prUrl, maxBytes = DIFF_MAX_BYTES_DEFAULT) {
    const { hostname, org, repo, prNumber } = parsePrUrl(prUrl);
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const resp = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`, {
        headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3.diff' },
        timeout: 30000,
    });
    const diff = resp.data || '';
    if (diff.length <= maxBytes)
        return diff;
    return diff.substring(0, maxBytes) + `\n...[truncated: ${diff.length - maxBytes} bytes omitted]`;
}
async function toolGetPastReviewers(filePaths, prAuthor) {
    const resp = await axios_1.default.post(`${HEROKU_API_URL}/api/past-reviewers`, { file_paths: filePaths, pr_author: prAuthor, top_k: 10 }, { headers: herokuHeaders(), timeout: 20000 });
    return resp.data.reviewers || [];
}
async function toolGetPastAuthors(filePaths, prAuthor) {
    const resp = await axios_1.default.post(`${HEROKU_API_URL}/api/past-authors`, { file_paths: filePaths, pr_author: prAuthor, top_k: 10 }, { headers: herokuHeaders(), timeout: 20000 });
    return resp.data.authors || [];
}
// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------
const TOOLS = [
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
function buildUserPrompt(prUrl, channelId) {
    return `PR URL: ${prUrl}\nSlack channel: ${channelId}\n\nSuggest up to 5 reviewers.`;
}
async function suggestReviewers(prUrl, channelId, messageTs) {
    log(`Processing ${prUrl}`);
    // Pre-parse to fail fast if URL is malformed
    parsePrUrl(prUrl);
    // Track cached author for the tool handlers (populated by fetch_pr_files)
    let cachedAuthor = '';
    const onToolCall = async (call) => {
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
        }
        catch (err) {
            log(`  tool error (${call.name}): ${err.message}`);
            return { tool_use_id: call.id, content: `Error: ${err.message}`, is_error: true };
        }
    };
    const result = await (0, claudeClient_1.claudeToolLoop)(SYSTEM_PROMPT, buildUserPrompt(prUrl, channelId), TOOLS, {
        temperature: 0.2,
        maxTokens: 2048,
        maxIterations: TOOL_CALL_CAP,
        onToolCall,
    });
    log(`  Claude made ${result.toolCalls.length} tool call(s) over ${result.iterations} round(s)`);
    // Parse JSON — handles plain JSON, ```json fences, and prose+JSON.
    // On failure, fall back to empty suggestions and still report, which marks
    // suggestions_sent=TRUE so we don't loop forever on a bad response.
    let suggestions = [];
    const parsed = (0, claudeClient_1.extractJsonFromClaudeText)(result.finalText);
    if (parsed && Array.isArray(parsed.suggestions)) {
        suggestions = parsed.suggestions;
    }
    else {
        logError(`  Failed to extract JSON from Claude output. Raw: ${result.finalText.substring(0, 300)}`);
        // Fall through to POST with empty suggestions — keeps the PR from being retried forever.
    }
    suggestions = suggestions
        .filter(s => s && typeof s.ghe_login === 'string' && s.ghe_login.trim().length > 0)
        .slice(0, 5);
    log(`  Claude returned ${suggestions.length} suggestion(s)`);
    // Report to Heroku: stores the list and triggers Slack thread reply
    try {
        await axios_1.default.post(`${HEROKU_API_URL}/api/pr-reviewers`, {
            pr_url: prUrl,
            channel_id: channelId,
            message_ts: messageTs,
            suggestions,
        }, { headers: herokuHeaders(), timeout: 30000 });
        log('  ✅ Reviewer suggestions reported.');
    }
    catch (err) {
        logError(`  Failed to report results: ${err.message}`);
    }
}
// ---------------------------------------------------------------------------
// Polling mode
// ---------------------------------------------------------------------------
async function fetchPrsNeedingSuggestions() {
    const resp = await axios_1.default.get(`${HEROKU_API_URL}/api/prs-needing-reviewer-suggestions`, {
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
async function runSuggestReviewersLoop() {
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
        }
        catch (e) {
            logError(`Failed for ${pr.pr_url}: ${e.message}`);
        }
    }
}
// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
async function run() {
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
    const health = await (0, claudeClient_1.checkClaudeHealth)();
    if (!health.ok) {
        logError(`Claude not ready: ${health.error || 'unknown'}`);
        process.exit(1);
    }
    log(`Claude AI model ready: ${(0, claudeClient_1.getClaudeModel)()}`);
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
    run().then(() => process.exit(0)).catch((err) => {
        logError(`Fatal: ${err.message}`);
        process.exit(1);
    });
}
//# sourceMappingURL=prAnalyzer.js.map