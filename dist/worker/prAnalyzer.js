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
 *   - get_channel_members(channel_id): resolved channel members with GHE logins
 *   - get_file_history(pr_url, file_path, limit?): recent commits touching a file
 *   - get_pr_reviewers(pr_url, pr_number): reviewers of a specific PR
 *
 * Usage:
 *   npm run suggest-reviewers -- https://gitcore.soma.salesforce.com/org/repo/pull/42
 *   (or the polling loop picks PRs from /api/prs-needing-reviewer-suggestions)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchFileCommits = fetchFileCommits;
exports.fetchPrReviews = fetchPrReviews;
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
async function fetchFileCommits(host, org, repo, filePath, limit = 20) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(host);
    const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };
    const resp = await axios_1.default.get(`https://${host}/api/v3/repos/${org}/${repo}/commits?path=${encodeURIComponent(filePath)}&per_page=${limit}`, { headers, timeout: 15000 });
    return (resp.data || []).map((c) => ({
        sha: c.sha,
        author_login: c.author?.login ?? null,
        date: c.commit?.author?.date || '',
        message: c.commit?.message || '',
    }));
}
async function fetchPrReviews(host, org, repo, prNumber) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(host);
    const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };
    const resp = await axios_1.default.get(`https://${host}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/reviews?per_page=100`, { headers, timeout: 15000 });
    return (resp.data || [])
        .filter((r) => r.user && r.state !== 'DISMISSED')
        .map((r) => ({
        user_login: r.user.login,
        state: r.state,
        submitted_at: r.submitted_at || '',
    }));
}
async function toolGetChannelMembers(channelId) {
    const resp = await axios_1.default.post(`${HEROKU_API_URL}/api/channel-members`, { channel_id: channelId }, { headers: herokuHeaders(), timeout: 15000 });
    return resp.data.members || [];
}
async function toolGetFileHistory(prUrl, filePath, limit = 20) {
    const { hostname, org, repo } = parsePrUrl(prUrl);
    return fetchFileCommits(hostname, org, repo, filePath, limit);
}
async function toolGetPrReviewers(prUrl, prNumber) {
    const { hostname, org, repo } = parsePrUrl(prUrl);
    return fetchPrReviews(hostname, org, repo, prNumber);
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
function buildUserPrompt(prUrl, channelId) {
    return `PR URL: ${prUrl}\nSlack channel: ${channelId}\n\nSuggest up to 5 reviewers.`;
}
async function suggestReviewers(prUrl, channelId, messageTs) {
    log(`Processing ${prUrl}`);
    // Pre-parse to fail fast if URL is malformed
    parsePrUrl(prUrl);
    const onToolCall = async (call) => {
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
    let notice;
    const members = await toolGetChannelMembers(channelId);
    if (members.length === 0) {
        if (suggestions.length > 0) {
            log(`  Channel ${channelId} has no bootstrap data; dropping ${suggestions.length} suggestion(s).`);
        }
        suggestions = [];
        notice = 'channel_not_bootstrapped';
    }
    else {
        const allowed = new Set(members.map(m => m.ghe_login.toLowerCase()));
        const before = suggestions.length;
        suggestions = suggestions.filter(s => allowed.has(s.ghe_login.toLowerCase()));
        const dropped = before - suggestions.length;
        if (dropped > 0)
            log(`  Dropped ${dropped} suggestion(s) not in channel members.`);
    }
    log(`  Claude returned ${suggestions.length} suggestion(s)`);
    // Report to Heroku: stores the list and triggers Slack thread reply
    try {
        await axios_1.default.post(`${HEROKU_API_URL}/api/pr-reviewers`, {
            pr_url: prUrl,
            channel_id: channelId,
            message_ts: messageTs,
            suggestions,
            ...(notice ? { notice } : {}),
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