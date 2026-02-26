"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const http = __importStar(require("http"));
const app_1 = require("./app");
const client_1 = require("./db/client");
// Simple body parser for JSON
async function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            }
            catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}
// Validate worker API key
function validateApiKey(req) {
    const apiKey = req.headers['x-worker-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    const expectedKey = process.env.WORKER_API_KEY;
    if (!expectedKey) {
        console.warn('WORKER_API_KEY not set - worker API disabled');
        return false;
    }
    return apiKey === expectedKey;
}
// Format AI analysis results into Slack message blocks
const SLACK_SECTION_LIMIT = 2900; // Slack section text limit is 3000; leave margin
function pushChunkedSections(blocks, header, lines) {
    let current = header;
    for (let line of lines) {
        // Truncate any single line that exceeds the limit on its own
        if (line.length > SLACK_SECTION_LIMIT - 10) {
            line = line.substring(0, SLACK_SECTION_LIMIT - 13) + '...';
        }
        if (current.length + 1 + line.length > SLACK_SECTION_LIMIT) {
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: current } });
            current = line;
        }
        else {
            current += '\n' + line;
        }
    }
    if (current) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: current } });
    }
}
function formatSlackAnalysis(review, reviewers, prUrl) {
    const blocks = [];
    // Header
    blocks.push({
        type: 'section',
        text: {
            type: 'mrkdwn',
            text: ':robot_face: *AI Review Intelligence*',
        },
    });
    // Review comments grouped by severity
    const SEVERITY_CONFIG = [
        { key: 'critical', emoji: ':red_circle:', label: 'Critical' },
        { key: 'high', emoji: ':large_orange_circle:', label: 'High' },
        { key: 'medium', emoji: ':large_yellow_circle:', label: 'Medium' },
        { key: 'low', emoji: ':large_blue_circle:', label: 'Low' },
    ];
    const comments = review?.comments || [];
    if (comments.length > 0) {
        const bySeverity = { critical: [], high: [], medium: [], low: [] };
        for (const c of comments) {
            const sev = bySeverity[c.severity] ? c.severity : 'medium';
            bySeverity[sev].push(c);
        }
        // Estimate overhead blocks (header, summary, reviewers, dividers, overall feedback)
        const OVERHEAD_BLOCKS = 14;
        const MAX_BLOCKS = 50;
        // Each comment with feedback = 2 blocks (section + actions); severity header = 1 context block
        const activeSeverities = SEVERITY_CONFIG.filter(s => bySeverity[s.key].length > 0).length;
        const perCommentBudget = MAX_BLOCKS - OVERHEAD_BLOCKS - activeSeverities;
        const usePerCommentFeedback = prUrl && (comments.length * 2 <= perCommentBudget);
        // Build a global comment index so feedback buttons reference the original position
        let globalIdx = 0;
        const commentIndexMap = new Map();
        for (const { key } of SEVERITY_CONFIG) {
            for (const c of bySeverity[key]) {
                commentIndexMap.set(c, globalIdx++);
            }
        }
        for (const { key, emoji, label } of SEVERITY_CONFIG) {
            if (bySeverity[key].length === 0)
                continue;
            // Severity header
            blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${emoji} *${label}*` }] });
            if (usePerCommentFeedback) {
                // Per-comment: one section + one actions block per comment
                for (const c of bySeverity[key]) {
                    const prefix = c.file_path ? `\`${c.file_path}\`` : '';
                    const hint = c.line_hint ? ` (${c.line_hint})` : '';
                    const tag = c.type ? ` [${c.type}]` : '';
                    let text = `${prefix}${hint}${tag} ${c.comment}`;
                    if (c.reason)
                        text += `\n_${c.reason}_`;
                    if (c.suggested_fix) {
                        const fix = c.suggested_fix.length > 400 ? c.suggested_fix.substring(0, 397) + '...' : c.suggested_fix;
                        text += `\n\`\`\`\n${fix}\n\`\`\``;
                    }
                    if (c.source)
                        text += `\n:paperclip: ${c.source}`;
                    if (text.length > SLACK_SECTION_LIMIT)
                        text = text.substring(0, SLACK_SECTION_LIMIT - 3) + '...';
                    blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });
                    const idx = commentIndexMap.get(c) ?? 0;
                    const val = JSON.stringify({ pr_url: prUrl, idx });
                    blocks.push({
                        type: 'actions',
                        elements: [
                            {
                                type: 'button',
                                text: { type: 'plain_text', text: ':thumbsup:', emoji: true },
                                action_id: 'comment_helpful',
                                value: val,
                            },
                            {
                                type: 'button',
                                text: { type: 'plain_text', text: ':thumbsdown:', emoji: true },
                                action_id: 'comment_not_helpful',
                                value: val,
                            },
                        ],
                    });
                }
            }
            else {
                // Fallback: grouped format (no per-comment buttons)
                const lines = [];
                for (const c of bySeverity[key]) {
                    const prefix = c.file_path ? `\`${c.file_path}\`` : '';
                    const hint = c.line_hint ? ` (${c.line_hint})` : '';
                    const tag = c.type ? ` [${c.type}]` : '';
                    let line = `• ${prefix}${hint}${tag} ${c.comment}`;
                    if (c.reason)
                        line += `\n  _${c.reason}_`;
                    if (c.suggested_fix) {
                        const fix = c.suggested_fix.length > 400 ? c.suggested_fix.substring(0, 397) + '...' : c.suggested_fix;
                        line += `\n\`\`\`\n${fix}\n\`\`\``;
                    }
                    if (c.source)
                        line += `\n  :paperclip: ${c.source}`;
                    lines.push(line);
                }
                pushChunkedSections(blocks, '', lines);
            }
        }
    }
    else {
        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: '_No specific review comments generated._',
            },
        });
    }
    // Summary
    if (review?.summary) {
        const summaryText = `*Summary:* ${review.summary}`.substring(0, SLACK_SECTION_LIMIT);
        blocks.push({
            type: 'context',
            elements: [{
                    type: 'mrkdwn',
                    text: summaryText,
                }],
        });
    }
    // Divider before reviewers
    blocks.push({ type: 'divider' });
    // Suggested reviewers — conversational @mention with review request
    if (reviewers && reviewers.length > 0) {
        const mentionList = reviewers.map((r) => r.slack_user_id ? `<@${r.slack_user_id}>` : `\`${r.ghe_login}\``);
        const mentionStr = mentionList.length === 1
            ? mentionList[0]
            : mentionList.slice(0, -1).join(', ') + ' and ' + mentionList[mentionList.length - 1];
        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `:eyes: Hey ${mentionStr}, could you take a look at this PR?`,
            },
        });
        const reasonLines = reviewers.map((r) => {
            const mention = r.slack_user_id ? `<@${r.slack_user_id}>` : `\`${r.ghe_login}\``;
            return `• ${mention} — ${r.reason}`;
        }).join('\n');
        blocks.push({
            type: 'context',
            elements: [{
                    type: 'mrkdwn',
                    text: reasonLines,
                }],
        });
    }
    else {
        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: '_No reviewer suggestions available yet._',
            },
        });
    }
    // Feedback solicitation
    blocks.push({ type: 'divider' });
    blocks.push({
        type: 'context',
        elements: [{
                type: 'mrkdwn',
                text: ':speech_balloon: Was this review helpful? Your feedback helps improve future suggestions.',
            }],
    });
    if (prUrl) {
        blocks.push({
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    text: { type: 'plain_text', text: ':thumbsup: Helpful', emoji: true },
                    action_id: 'ai_review_helpful',
                    value: prUrl,
                    style: 'primary',
                },
                {
                    type: 'button',
                    text: { type: 'plain_text', text: ':thumbsdown: Not Helpful', emoji: true },
                    action_id: 'ai_review_not_helpful',
                    value: prUrl,
                },
            ],
        });
    }
    const text = `:robot_face: AI Review Intelligence — ${comments.length} comment(s), ${reviewers?.length || 0} reviewer suggestion(s)`;
    return { text, blocks };
}
async function main() {
    // Validate required environment variables
    const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN', 'ALLOWED_CHANNEL_IDS'];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        process.exit(1);
    }
    if (!process.env.GHE_TOKEN && !process.env.GHE_TOKENS) {
        console.error('Missing required environment variable: GHE_TOKEN or GHE_TOKENS (at least one must be set)');
        process.exit(1);
    }
    const app = (0, app_1.createApp)();
    // Add Socket Mode connection event listeners BEFORE starting
    const socketModeClient = app.receiver?.client;
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
        socketModeClient.on('error', (error) => {
            console.error('[Socket Mode] Error:', error.message);
        });
        socketModeClient.on('unable_to_socket_mode_start', (error) => {
            console.error('[Socket Mode] Unable to start:', error.message);
        });
        console.log('[Socket Mode] Event listeners registered');
    }
    else {
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
                const prs = await (0, client_1.getPRsNeedingStatusCheck)();
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
                const results = body.results || [];
                if (!Array.isArray(results)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid request body: expected { results: [...] }' }));
                    return;
                }
                let updated = 0;
                for (const result of results) {
                    if (result.pr_url && typeof result.is_open === 'boolean' && typeof result.has_reviews === 'boolean') {
                        await (0, client_1.updatePRStatus)(result.pr_url, result.is_open, result.has_reviews);
                        updated++;
                    }
                }
                console.log(`[Worker API] Updated status for ${updated} PRs`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ updated }));
                return;
            }
            // ========== AI Knowledge Base API Endpoints ==========
            // Get tracked PRs that haven't been harvested yet
            if (url === '/api/tracked-prs-for-harvest' && method === 'GET') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const result = await client_1.pool.query(`
          SELECT DISTINCT tp.pr_url, tp.org, tp.repo, tp.pr_number, tp.channel_id, tp.message_ts
          FROM tracked_prs tp
          LEFT JOIN (
            SELECT DISTINCT pr_url FROM pr_reviews
          ) pr ON tp.pr_url = pr.pr_url
          WHERE pr.pr_url IS NULL
          ORDER BY tp.pr_number ASC
        `);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ prs: result.rows }));
                return;
            }
            // Get ALL tracked PRs (for full re-harvest)
            if (url === '/api/all-tracked-prs' && method === 'GET') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const result = await client_1.pool.query(`
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
                const repos = await (0, client_1.getDistinctRepos)();
                // Infer hostname from tracked_prs pr_url
                const reposWithHost = [];
                for (const r of repos) {
                    const row = await client_1.pool.query('SELECT pr_url FROM tracked_prs WHERE org = $1 AND repo = $2 LIMIT 1', [r.org, r.repo]);
                    const prUrl = row.rows[0]?.pr_url || '';
                    const hostMatch = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)/);
                    reposWithHost.push({ ...r, hostname: hostMatch ? hostMatch[1] : '' });
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ repos: reposWithHost }));
                return;
            }
            // Get harvest state for a repo
            if (url.startsWith('/api/harvest-state') && method === 'GET') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const params = new URL(url, `http://${req.headers.host}`).searchParams;
                const org = params.get('org') || '';
                const repo = params.get('repo') || '';
                const state = await (0, client_1.getHarvestState)(org, repo);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ state }));
                return;
            }
            // Receive harvested PR data (reviews + files)
            if (url === '/api/harvest-data' && method === 'POST') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const body = await parseJsonBody(req);
                let reviewCount = 0;
                let fileCount = 0;
                for (const review of (body.reviews || [])) {
                    await (0, client_1.insertPRReview)(review);
                    reviewCount++;
                }
                for (const file of (body.files || [])) {
                    await (0, client_1.insertPRFile)(file);
                    fileCount++;
                }
                if (body.harvest_state) {
                    await (0, client_1.upsertHarvestState)(body.harvest_state.org, body.harvest_state.repo, body.harvest_state.last_pr_number);
                }
                console.log(`[Worker API] Harvested ${reviewCount} reviews, ${fileCount} files`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ reviews: reviewCount, files: fileCount }));
                return;
            }
            // Receive repo knowledge chunks
            if (url === '/api/repo-knowledge' && method === 'POST') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const body = await parseJsonBody(req);
                let chunkCount = 0;
                for (const chunk of (body.chunks || [])) {
                    await (0, client_1.upsertRepoKnowledge)(chunk);
                    chunkCount++;
                }
                if (body.harvest_state) {
                    await (0, client_1.upsertRepoHarvestState)(body.harvest_state.org, body.harvest_state.repo, body.harvest_state.sha);
                }
                console.log(`[Worker API] Stored ${chunkCount} repo knowledge chunks`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ chunks: chunkCount }));
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
                    await (0, client_1.upsertUserMapping)(mapping);
                    count++;
                }
                console.log(`[Worker API] Upserted ${count} user mappings`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ count }));
                return;
            }
            // Receive embeddings from worker
            if (url === '/api/embeddings' && method === 'POST') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const body = await parseJsonBody(req);
                let count = 0;
                for (const emb of (body.embeddings || [])) {
                    await (0, client_1.insertEmbedding)(emb.content_type, emb.source_id, emb.content_text, emb.embedding, emb.metadata || {});
                    count++;
                }
                console.log(`[Worker API] Stored ${count} embeddings`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ count }));
                return;
            }
            // Receive repo knowledge embedding updates
            if (url === '/api/repo-knowledge-embeddings' && method === 'POST') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const body = await parseJsonBody(req);
                let count = 0;
                for (const update of (body.updates || [])) {
                    await (0, client_1.updateRepoKnowledgeEmbedding)(update.id, update.embedding);
                    count++;
                }
                console.log(`[Worker API] Updated ${count} repo knowledge embeddings`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ count }));
                return;
            }
            // Get un-embedded reviews
            if (url.startsWith('/api/unembedded-reviews') && method === 'GET') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const params = new URL(url, `http://${req.headers.host}`).searchParams;
                const limit = parseInt(params.get('limit') || '50', 10);
                const reviews = await (0, client_1.getUnembeddedPRReviews)(limit);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ reviews }));
                return;
            }
            // Get un-embedded repo knowledge chunks
            if (url.startsWith('/api/unembedded-repo-knowledge') && method === 'GET') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const params = new URL(url, `http://${req.headers.host}`).searchParams;
                const limit = parseInt(params.get('limit') || '50', 10);
                const chunks = await (0, client_1.getUnembeddedRepoKnowledge)(limit);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ chunks }));
                return;
            }
            // Vector search: similar reviews
            if (url === '/api/search-similar-reviews' && method === 'POST') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const body = await parseJsonBody(req);
                const reviews = await (0, client_1.searchSimilarReviews)(body.embedding, body.top_k || 10);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ reviews }));
                return;
            }
            // Vector search: similar code
            if (url === '/api/search-similar-code' && method === 'POST') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const body = await parseJsonBody(req);
                const chunks = await (0, client_1.searchSimilarCode)(body.embedding, body.top_k || 5);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ chunks }));
                return;
            }
            // Get suggested reviewers by file paths
            if (url === '/api/suggested-reviewers' && method === 'POST') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const body = await parseJsonBody(req);
                const filePaths = body.file_paths || [];
                const prAuthor = body.pr_author || '';
                const similarReviewsFromVector = body.similar_reviews || [];
                // Combine file-based reviewers and code touchers
                const reviewers = await (0, client_1.findReviewersByFiles)(filePaths, 10);
                const touchers = await (0, client_1.findCodeTouchersByFiles)(filePaths, 10);
                // Build candidate list with scores — track signals separately
                const candidateMap = new Map();
                const ensureCandidate = (login) => {
                    if (!candidateMap.has(login)) {
                        candidateMap.set(login, {
                            ghe_login: login, score: 0, files: [],
                            hasReviewed: false, hasAuthored: false, hasSemantic: false,
                        });
                    }
                    return candidateMap.get(login);
                };
                // Signal 1: Past reviewers of similar files (capped)
                for (const r of reviewers) {
                    if (r.reviewer_login === prAuthor)
                        continue;
                    const c = ensureCandidate(r.reviewer_login);
                    c.score += Math.min(r.review_count, 20) * 2;
                    c.files = [...new Set([...c.files, ...r.files])];
                    c.hasReviewed = true;
                }
                // Signal 2: Past authors of changes to similar files (capped)
                for (const t of touchers) {
                    if (t.author_login === prAuthor)
                        continue;
                    const c = ensureCandidate(t.author_login);
                    c.score += Math.min(t.change_count, 20);
                    c.files = [...new Set([...c.files, ...t.files])];
                    c.hasAuthored = true;
                }
                // Signal 3: Reviewers from semantically similar past reviews
                if (similarReviewsFromVector.length > 0) {
                    const semanticCounts = new Map();
                    for (const sr of similarReviewsFromVector) {
                        if (!sr.reviewer_login || sr.reviewer_login === prAuthor)
                            continue;
                        semanticCounts.set(sr.reviewer_login, (semanticCounts.get(sr.reviewer_login) || 0) + 1);
                    }
                    for (const [login, count] of semanticCounts) {
                        const c = ensureCandidate(login);
                        c.score += count * 3;
                        c.hasSemantic = true;
                    }
                }
                // Generate natural reasons
                for (const c of candidateMap.values()) {
                    const parts = [];
                    if (c.hasReviewed && c.hasAuthored) {
                        parts.push("you've reviewed and contributed to similar files in this area");
                    }
                    else if (c.hasReviewed) {
                        parts.push("you've reviewed similar files in this area before");
                    }
                    else if (c.hasAuthored) {
                        parts.push("you've made changes to related code");
                    }
                    if (c.hasSemantic) {
                        parts.push(parts.length > 0
                            ? 'and have context from reviewing closely related PRs'
                            : "you've reviewed closely related PRs before");
                    }
                    c.reason = parts.join(' ') || 'familiar with this area of the codebase';
                }
                // Resolve Slack IDs and filter to only mapped users
                const sorted = Array.from(candidateMap.values()).sort((a, b) => b.score - a.score);
                const mapped = [];
                for (const c of sorted) {
                    if (mapped.length >= 5)
                        break;
                    const mapping = await (0, client_1.getUserMapping)(c.ghe_login);
                    if (!mapping?.slack_user_id)
                        continue; // Skip users not in channel/mapping
                    c.slack_user_id = mapping.slack_user_id;
                    c.display_name = mapping.display_name || null;
                    mapped.push(c);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ reviewers: mapped }));
                return;
            }
            // Get PRs needing AI analysis (newly tracked, not yet analyzed)
            if (url === '/api/prs-needing-analysis' && method === 'GET') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const result = await client_1.pool.query(`
          SELECT tp.* FROM tracked_prs tp
          LEFT JOIN pr_analysis_results ar ON tp.pr_url = ar.pr_url
          WHERE ar.id IS NULL
            AND (tp.is_open = TRUE OR tp.is_open IS NULL)
            AND tp.created_at > NOW() - INTERVAL '24 hours'
          ORDER BY tp.created_at DESC
          LIMIT 10
        `);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ prs: result.rows }));
                return;
            }
            // Receive PR analysis results from worker and post to Slack
            if (url === '/api/pr-analysis' && method === 'POST') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const body = await parseJsonBody(req);
                const { pr_url, channel_id, message_ts, review, reviewers } = body;
                // Store analysis results
                await client_1.pool.query(`
          INSERT INTO pr_analysis_results (pr_url, channel_id, message_ts, review_json, reviewers_json, created_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (pr_url) DO UPDATE SET
            review_json = $4, reviewers_json = $5, created_at = NOW()
        `, [pr_url, channel_id, message_ts, JSON.stringify(review), JSON.stringify(reviewers)]);
                // Format and post Slack thread reply
                if (channel_id && channel_id !== 'manual' && message_ts && message_ts !== '0') {
                    try {
                        const slackMessage = formatSlackAnalysis(review, reviewers, pr_url);
                        await app.client.chat.postMessage({
                            channel: channel_id,
                            thread_ts: message_ts,
                            text: slackMessage.text,
                            blocks: slackMessage.blocks,
                            unfurl_links: false,
                        });
                        console.log(`[Worker API] Posted AI review to thread in ${channel_id}`);
                    }
                    catch (slackError) {
                        console.error(`[Worker API] Failed to post Slack message: ${slackError.message}`);
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            // Re-post a stored analysis to Slack (useful when original post failed)
            if (url === '/api/repost-analysis' && method === 'POST') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const body = await parseJsonBody(req);
                const { pr_url } = body;
                if (!pr_url) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'pr_url is required' }));
                    return;
                }
                // Look up stored analysis + tracked PR info
                const analysisRow = await client_1.pool.query(`SELECT ar.review_json, ar.reviewers_json, ar.channel_id, ar.message_ts
           FROM pr_analysis_results ar WHERE ar.pr_url = $1`, [pr_url]);
                if (analysisRow.rows.length === 0) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'No analysis found for this PR' }));
                    return;
                }
                const row = analysisRow.rows[0];
                const review = typeof row.review_json === 'string' ? JSON.parse(row.review_json) : row.review_json;
                const reviewers = typeof row.reviewers_json === 'string' ? JSON.parse(row.reviewers_json) : row.reviewers_json;
                const channelId = body.channel_id || row.channel_id;
                const messageTs = body.message_ts || row.message_ts;
                if (!channelId || channelId === 'manual') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'No channel_id available. Pass channel_id in request body.' }));
                    return;
                }
                try {
                    const slackMessage = formatSlackAnalysis(review, reviewers, pr_url);
                    await app.client.chat.postMessage({
                        channel: channelId,
                        thread_ts: messageTs && messageTs !== '0' ? messageTs : undefined,
                        text: slackMessage.text,
                        blocks: slackMessage.blocks,
                        unfurl_links: false,
                    });
                    console.log(`[Repost API] Re-posted AI review for ${pr_url} to ${channelId}`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                }
                catch (slackError) {
                    console.error(`[Repost API] Failed: ${slackError.message}`);
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `Slack post failed: ${slackError.message}` }));
                }
                return;
            }
            // ========== AI Review Feedback & Learning Endpoints ==========
            // Store manual feedback (from Slack buttons or direct API)
            if (url === '/api/ai-feedback' && method === 'POST') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const body = await parseJsonBody(req);
                const { pr_url, user_id, rating, feedback_text } = body;
                if (!pr_url || !user_id || !rating) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'pr_url, user_id, and rating are required' }));
                    return;
                }
                await (0, client_1.insertOrUpdateFeedback)(pr_url, user_id, rating, feedback_text);
                console.log(`[Worker API] Stored feedback: ${rating} for ${pr_url}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            // Get closed PRs needing lesson extraction
            if (url === '/api/prs-needing-lessons' && method === 'GET') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const prs = await (0, client_1.getPRsNeedingLessonExtraction)();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ prs }));
                return;
            }
            // Store lesson extraction results from reviewLearner worker
            if (url === '/api/ai-lessons' && method === 'POST') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const body = await parseJsonBody(req);
                const { pr_url, ai_review, peer_comments, lessons, embedding } = body;
                if (!pr_url) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'pr_url is required' }));
                    return;
                }
                await (0, client_1.insertReviewLessons)(pr_url, ai_review || {}, peer_comments || [], lessons || {}, embedding);
                console.log(`[Worker API] Stored lessons for ${pr_url} (embedding: ${embedding ? 'yes' : 'no'})`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                return;
            }
            // Get combined learning context (lessons + feedback) for LLM prompt enrichment
            // POST with embedding → semantic similarity search; GET → recency fallback
            if (url.startsWith('/api/ai-learning-context') && (method === 'POST' || method === 'GET')) {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const params = new URL(url, `http://${req.headers.host}`).searchParams;
                const limit = parseInt(params.get('limit') || '5', 10);
                let lessons;
                if (method === 'POST') {
                    const body = await parseJsonBody(req);
                    if (body.embedding && Array.isArray(body.embedding) && body.embedding.length > 0) {
                        lessons = await (0, client_1.getSimilarLessons)(body.embedding, Math.min(limit, 5));
                        console.log(`[Worker API] Returning ${lessons.length} similar lessons (by embedding)`);
                    }
                    else {
                        lessons = await (0, client_1.getRecentLessons)(Math.min(limit, 5));
                    }
                }
                else {
                    lessons = await (0, client_1.getRecentLessons)(Math.min(limit, 5));
                }
                const feedback = await (0, client_1.getRecentFeedback)(Math.min(limit, 3));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ lessons, feedback }));
                return;
            }
            // Get closed tracked PRs that don't have lessons yet (for bootstrap learning)
            if (url.startsWith('/api/closed-prs-without-lessons') && method === 'GET') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const params = new URL(url, `http://${req.headers.host}`).searchParams;
                const limit = Math.min(parseInt(params.get('limit') || '50', 10), 100);
                const force = params.get('force') === 'true';
                let result;
                if (force) {
                    // Return all closed PRs (for re-processing / backfilling embeddings)
                    result = await client_1.pool.query(`
            SELECT tp.pr_url, tp.org, tp.repo, tp.pr_number, tp.channel_id, tp.message_ts
            FROM tracked_prs tp
            JOIN pr_analysis_results ar ON tp.pr_url = ar.pr_url
            WHERE tp.is_open = FALSE
            ORDER BY tp.created_at DESC
            LIMIT $1
          `, [limit]);
                }
                else {
                    result = await client_1.pool.query(`
            SELECT tp.pr_url, tp.org, tp.repo, tp.pr_number, tp.channel_id, tp.message_ts
            FROM tracked_prs tp
            LEFT JOIN ai_review_lessons al ON tp.pr_url = al.pr_url
            WHERE tp.is_open = FALSE AND al.id IS NULL
            ORDER BY tp.created_at DESC
            LIMIT $1
          `, [limit]);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ prs: result.rows }));
                return;
            }
            // --- Team Documents ---
            // Vector search: similar docs
            if (url === '/api/search-similar-docs' && method === 'POST') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const body = await parseJsonBody(req);
                const docs = await (0, client_1.searchSimilarDocs)(body.embedding, body.top_k || 3);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ docs }));
                return;
            }
            // Register / list / delete team documents
            if (url.startsWith('/api/team-documents')) {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                if (method === 'GET') {
                    const docs = await (0, client_1.listDocuments)();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ docs }));
                    return;
                }
                if (method === 'POST') {
                    const body = await parseJsonBody(req);
                    const { source_url, title, doc_type, chunks } = body;
                    if (!source_url || !title || !chunks || !Array.isArray(chunks)) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'source_url, title, and chunks[] are required' }));
                        return;
                    }
                    const inserted = await (0, client_1.upsertDocumentChunks)(source_url, title, doc_type || 'design', chunks);
                    console.log(`[Worker API] Stored ${inserted} chunks for doc "${title}"`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, chunks_stored: inserted }));
                    return;
                }
                if (method === 'DELETE') {
                    const body = await parseJsonBody(req);
                    if (!body.source_url) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'source_url is required' }));
                        return;
                    }
                    const deleted = await (0, client_1.deleteDocument)(body.source_url);
                    console.log(`[Worker API] Deleted ${deleted} chunks for doc "${body.source_url}"`);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, chunks_deleted: deleted }));
                    return;
                }
            }
            // Not found
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
        }
        catch (error) {
            console.error('API error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message || 'Internal Server Error' }));
        }
    });
    server.listen(port, () => {
        console.log(`HTTP server listening on port ${port}`);
        console.log(`  - Health check: GET /health`);
        console.log(`  - Worker API: GET /api/pending-prs, POST /api/pr-status`);
        console.log(`  - AI API: /api/harvest-data, /api/repo-knowledge, /api/embeddings, /api/pr-analysis, ...`);
    });
}
main().catch((error) => {
    console.error('Failed to start app:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map