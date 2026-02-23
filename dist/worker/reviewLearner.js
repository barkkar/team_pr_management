#!/usr/bin/env npx ts-node
"use strict";
/**
 * Review Learner Worker
 *
 * After a PR is closed/merged, compares the AI review with actual peer review
 * comments and uses the LLM to generate structured lessons for improving
 * future AI reviews.
 *
 * Usage:
 *   npm run review-learn              # Run once
 *   npm run review-learn:watch        # Run every 10 minutes
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const axios_1 = __importDefault(require("axios"));
const ollama_1 = require("ollama");
const gheTokenResolver_1 = require("../src/utils/gheTokenResolver");
const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';
const POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
let ollama = null;
function getOllama() {
    if (!ollama)
        ollama = new ollama_1.Ollama({ host: OLLAMA_HOST });
    return ollama;
}
function log(msg) {
    console.log(`[${new Date().toISOString()}] [ReviewLearner] ${msg}`);
}
function logError(msg) {
    console.error(`[${new Date().toISOString()}] [ReviewLearner] ${msg}`);
}
function herokuHeaders() {
    return { 'Content-Type': 'application/json', 'X-Worker-API-Key': WORKER_API_KEY };
}
function extractHostname(prUrl) {
    const match = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)/);
    return match ? match[1] : null;
}
// ---------------------------------------------------------------------------
// GHE: Fetch peer review comments for a closed PR
// ---------------------------------------------------------------------------
async function fetchPeerComments(hostname, org, repo, prNumber) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };
    const base = `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`;
    const comments = [];
    // Inline review comments (diff comments)
    try {
        const resp = await axios_1.default.get(`${base}/comments`, {
            params: { per_page: 100 }, headers, timeout: 30000,
        });
        for (const c of resp.data || []) {
            comments.push({
                reviewer: c.user?.login || 'unknown',
                file_path: c.path || null,
                body: (c.body || '').substring(0, 500),
                type: 'inline',
            });
        }
    }
    catch (e) {
        logError(`  Failed to fetch inline comments: ${e.message}`);
    }
    // Top-level reviews (APPROVED, CHANGES_REQUESTED, etc.)
    try {
        const resp = await axios_1.default.get(`${base}/reviews`, {
            params: { per_page: 100 }, headers, timeout: 30000,
        });
        for (const r of resp.data || []) {
            if (r.body && r.body.trim().length > 0) {
                comments.push({
                    reviewer: r.user?.login || 'unknown',
                    file_path: null,
                    body: (r.body || '').substring(0, 500),
                    type: r.state || 'COMMENTED',
                });
            }
        }
    }
    catch (e) {
        logError(`  Failed to fetch top-level reviews: ${e.message}`);
    }
    return comments;
}
async function generateLessons(aiReview, peerComments) {
    const client = getOllama();
    const systemPrompt = `You are analyzing the quality of an AI code review by comparing it to actual human peer review comments on the same PR. You MUST respond with valid JSON only.

Return a JSON object with this exact structure:
{"ai_correct": ["things AI got right"], "ai_missed": ["things peers caught that AI missed"], "ai_wrong": ["things AI said that were inaccurate or unhelpful"], "key_takeaway": "one sentence summary of what to improve"}

Rules:
- ai_correct: AI comments that align with what peers also flagged
- ai_missed: Important issues peers raised that AI didn't mention at all
- ai_wrong: AI comments that were wrong, irrelevant, or too generic
- key_takeaway: Actionable one-liner for improving future reviews
- If peers had no substantive comments, note that AI review was sufficient
- Be concise — each item should be one sentence`;
    const aiComments = (aiReview.comments || [])
        .map((c) => `- [${c.type || 'comment'}] ${c.file_path || 'general'}: ${c.comment}`)
        .join('\n');
    const peerLines = peerComments
        .map(c => `- [${c.reviewer}] ${c.file_path || 'general'}: ${c.body}`)
        .join('\n');
    const userPrompt = `Compare these two reviews of the same PR:

AI Review (${(aiReview.comments || []).length} comments):
${aiComments || '(no AI comments)'}

AI Summary: ${aiReview.summary || 'N/A'}

Peer Review (${peerComments.length} comments):
${peerLines || '(no peer comments)'}

Respond with JSON: {"ai_correct": [...], "ai_missed": [...], "ai_wrong": [...], "key_takeaway": "..."}`;
    try {
        const response = await client.chat({
            model: OLLAMA_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            format: 'json',
            options: { temperature: 0.3, num_predict: 2048 },
        });
        const parsed = JSON.parse(response.message.content.trim());
        return {
            ai_correct: Array.isArray(parsed.ai_correct) ? parsed.ai_correct : [],
            ai_missed: Array.isArray(parsed.ai_missed) ? parsed.ai_missed : [],
            ai_wrong: Array.isArray(parsed.ai_wrong) ? parsed.ai_wrong : [],
            key_takeaway: String(parsed.key_takeaway || ''),
        };
    }
    catch (e) {
        logError(`  LLM lesson generation failed: ${e.message}`);
        return { ai_correct: [], ai_missed: [], ai_wrong: [], key_takeaway: 'Lesson extraction failed' };
    }
}
// ---------------------------------------------------------------------------
// Heroku API helpers
// ---------------------------------------------------------------------------
async function fetchPRsNeedingLessons() {
    const resp = await axios_1.default.get(`${HEROKU_API_URL}/api/prs-needing-lessons`, {
        headers: herokuHeaders(), timeout: 30000,
    });
    return resp.data.prs || [];
}
async function reportLessons(prUrl, aiReview, peerComments, lessons) {
    await axios_1.default.post(`${HEROKU_API_URL}/api/ai-lessons`, {
        pr_url: prUrl,
        ai_review: aiReview,
        peer_comments: peerComments,
        lessons,
    }, { headers: herokuHeaders(), timeout: 30000 });
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function runWorker() {
    log('='.repeat(60));
    log('Review Learner starting...');
    if (!HEROKU_API_URL || !WORKER_API_KEY) {
        logError('HEROKU_API_URL and WORKER_API_KEY are required');
        process.exit(1);
    }
    try {
        // 1. Get closed PRs that have AI reviews but no lessons yet
        const prs = await fetchPRsNeedingLessons();
        log(`Found ${prs.length} PR(s) needing lesson extraction`);
        if (prs.length === 0) {
            log('Nothing to process. Done!');
            return;
        }
        for (const pr of prs) {
            const { pr_url, review_json, org, repo, pr_number } = pr;
            log(`\nProcessing ${org}/${repo}#${pr_number}...`);
            const hostname = extractHostname(pr_url);
            if (!hostname) {
                logError(`  Cannot extract hostname from ${pr_url}`);
                continue;
            }
            // 2. Fetch actual peer review comments from GHE
            log('  Fetching peer review comments...');
            const peerComments = await fetchPeerComments(hostname, org, repo, pr_number);
            log(`  Found ${peerComments.length} peer comment(s)`);
            if (peerComments.length === 0) {
                log('  No peer comments to compare against. Skipping.');
                // Still store a lesson so we don't re-process
                await reportLessons(pr_url, review_json, [], {
                    ai_correct: [], ai_missed: [], ai_wrong: [],
                    key_takeaway: 'No peer comments available for comparison',
                });
                continue;
            }
            // 3. Compare AI review vs peer comments via LLM
            log('  Generating lessons via LLM...');
            const lessons = await generateLessons(review_json, peerComments);
            log(`  Results:`);
            log(`    AI correct: ${lessons.ai_correct.length} item(s)`);
            log(`    AI missed:  ${lessons.ai_missed.length} item(s)`);
            log(`    AI wrong:   ${lessons.ai_wrong.length} item(s)`);
            log(`    Takeaway:   ${lessons.key_takeaway}`);
            // 4. Store lessons
            log('  Storing lessons...');
            await reportLessons(pr_url, review_json, peerComments, lessons);
            log('  ✅ Done');
            // Small delay between PRs
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        log('\nReview Learner completed!');
    }
    catch (e) {
        logError(`Worker error: ${e.message}`);
        if (e.response) {
            logError(`Response: ${e.response.status} ${JSON.stringify(e.response.data)}`);
        }
        process.exit(1);
    }
}
async function runWatchMode() {
    log('Starting in watch mode (every 10 minutes)...');
    await runWorker();
    setInterval(async () => {
        try {
            await runWorker();
        }
        catch (e) {
            logError(`Run failed: ${e}`);
        }
    }, POLL_INTERVAL_MS);
}
const isWatch = process.argv.includes('--watch') || process.argv.includes('-w');
if (isWatch) {
    runWatchMode();
}
else {
    runWorker().then(() => process.exit(0)).catch(e => { logError(`Fatal: ${e}`); process.exit(1); });
}
//# sourceMappingURL=reviewLearner.js.map