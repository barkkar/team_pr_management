#!/usr/bin/env npx ts-node
"use strict";
/**
 * Local PR Status Checker Worker
 *
 * This script runs on your local machine (behind VPN) to check PR status
 * from GitHub Enterprise and report back to the Heroku app.
 *
 * Usage:
 *   npm run worker          # Run once
 *   npm run worker:watch    # Run every 5 minutes
 *
 * Required environment variables:
 *   HEROKU_API_URL    - URL of your Heroku app (e.g., https://pr-manager.herokuapp.com)
 *   WORKER_API_KEY    - API key for authentication (must match Heroku config)
 *   GHE_TOKEN         - GitHub Enterprise personal access token (single-host fallback)
 *   GHE_TOKENS        - JSON map of hostname->token for multi-host (optional, preferred)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const axios_1 = __importDefault(require("axios"));
const ollama_1 = require("ollama");
const gheTokenResolver_1 = require("../src/utils/gheTokenResolver");
function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}
function logError(message) {
    console.error(`[${new Date().toISOString()}] ${message}`);
}
// Configuration
const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let ollama = null;
function getOllama() {
    if (!ollama)
        ollama = new ollama_1.Ollama({ host: OLLAMA_HOST });
    return ollama;
}
/**
 * Extract hostname from a PR URL
 */
function extractHostname(prUrl) {
    const match = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)/);
    return match ? match[1] : null;
}
/**
 * Fetch pending PRs from Heroku API
 */
async function fetchPendingPRs() {
    const response = await axios_1.default.get(`${HEROKU_API_URL}/api/pending-prs`, {
        headers: {
            'X-Worker-API-Key': WORKER_API_KEY,
        },
        timeout: 30000,
    });
    return response.data.prs || [];
}
/**
 * Check PR status from GitHub Enterprise
 */
async function checkPRStatus(pr) {
    const hostname = extractHostname(pr.pr_url);
    if (!hostname) {
        return {
            pr_url: pr.pr_url,
            is_open: true,
            has_reviews: false,
            error: 'Could not extract hostname',
        };
    }
    const baseURL = `https://${hostname}/api/v3`;
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const headers = {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
    };
    try {
        // Get PR details
        const prResponse = await axios_1.default.get(`${baseURL}/repos/${pr.org}/${pr.repo}/pulls/${pr.pr_number}`, { headers, timeout: 10000 });
        const isOpen = prResponse.data.state === 'open' && !prResponse.data.merged;
        const prAuthor = prResponse.data.user?.login || '';
        // Get reviews (exclude author's own reviews)
        let hasReviews = false;
        if (isOpen) {
            const reviewsResponse = await axios_1.default.get(`${baseURL}/repos/${pr.org}/${pr.repo}/pulls/${pr.pr_number}/reviews`, { headers, timeout: 10000 });
            const externalReviews = (reviewsResponse.data || []).filter((r) => r.state !== 'PENDING' && r.user?.login !== prAuthor);
            hasReviews = externalReviews.length > 0;
        }
        return {
            pr_url: pr.pr_url,
            is_open: isOpen,
            has_reviews: hasReviews,
        };
    }
    catch (error) {
        logError(`  Error checking ${pr.pr_url}: ${error.message}`);
        return {
            pr_url: pr.pr_url,
            is_open: true,
            has_reviews: false,
            error: error.message,
        };
    }
}
/**
 * Report PR status back to Heroku
 */
async function reportStatus(results) {
    const validResults = results.filter(r => !r.error);
    if (validResults.length === 0) {
        return 0;
    }
    const response = await axios_1.default.post(`${HEROKU_API_URL}/api/pr-status`, { results: validResults }, {
        headers: {
            'Content-Type': 'application/json',
            'X-Worker-API-Key': WORKER_API_KEY,
        },
        timeout: 30000,
    });
    return response.data.updated || 0;
}
// ---------------------------------------------------------------------------
// Lesson Extraction — triggered automatically when PRs close
// ---------------------------------------------------------------------------
function herokuHeaders() {
    return { 'Content-Type': 'application/json', 'X-Worker-API-Key': WORKER_API_KEY };
}
async function fetchPeerComments(hostname, org, repo, prNumber) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };
    const base = `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`;
    const comments = [];
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
        logError(`    Failed to fetch inline comments: ${e.message}`);
    }
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
        logError(`    Failed to fetch top-level reviews: ${e.message}`);
    }
    return comments;
}
async function generateLessons(aiReview, peerComments) {
    const client = getOllama();
    const systemPrompt = `You are analyzing the quality of an AI code review by comparing it to actual human peer review comments on the same PR. You MUST respond with valid JSON only.

Return a JSON object with this exact structure:
{"ai_correct": ["things AI got right"], "ai_missed": ["things peers caught that AI missed"], "ai_wrong": ["things AI said that were inaccurate or unhelpful"], "key_takeaway": "one sentence summary of what to improve"}`;
    const aiComments = (aiReview.comments || [])
        .map((c) => `- [${c.type || 'comment'}] ${c.file_path || 'general'}: ${c.comment}`)
        .join('\n');
    const peerLines = peerComments
        .map((c) => `- [${c.reviewer}] ${c.file_path || 'general'}: ${c.body}`)
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
        logError(`    LLM lesson generation failed: ${e.message}`);
        return { ai_correct: [], ai_missed: [], ai_wrong: [], key_takeaway: 'Lesson extraction failed' };
    }
}
async function triggerLessonExtraction() {
    try {
        // Fetch closed PRs that have AI reviews but no lessons yet
        const resp = await axios_1.default.get(`${HEROKU_API_URL}/api/prs-needing-lessons`, {
            headers: herokuHeaders(), timeout: 30000,
        });
        const prs = resp.data.prs || [];
        if (prs.length === 0) {
            log('  No PRs need lesson extraction.');
            return;
        }
        log(`  Found ${prs.length} PR(s) needing lesson extraction`);
        for (const pr of prs) {
            const { pr_url, review_json, org, repo, pr_number } = pr;
            log(`  Processing ${org}/${repo}#${pr_number}...`);
            const hostname = extractHostname(pr_url);
            if (!hostname) {
                logError(`    Cannot extract hostname from ${pr_url}`);
                continue;
            }
            // Fetch peer comments
            const peerComments = await fetchPeerComments(hostname, org, repo, pr_number);
            log(`    ${peerComments.length} peer comment(s)`);
            let lessons;
            if (peerComments.length === 0) {
                lessons = { ai_correct: [], ai_missed: [], ai_wrong: [], key_takeaway: 'No peer comments available for comparison' };
            }
            else {
                log('    Generating lessons via LLM...');
                lessons = await generateLessons(review_json, peerComments);
                log(`    Takeaway: ${lessons.key_takeaway}`);
            }
            // Store lessons
            await axios_1.default.post(`${HEROKU_API_URL}/api/ai-lessons`, {
                pr_url, ai_review: review_json, peer_comments: peerComments, lessons,
            }, { headers: herokuHeaders(), timeout: 30000 });
            log('    ✅ Lessons stored');
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    catch (e) {
        logError(`  Lesson extraction error: ${e.message}`);
    }
}
/**
 * Main worker function
 */
async function runWorker() {
    log(`${'='.repeat(50)}`);
    log(`PR Status Worker starting...`);
    log(`${'='.repeat(50)}`);
    // Validate configuration
    if (!HEROKU_API_URL) {
        logError('ERROR: HEROKU_API_URL environment variable is required');
        logError('Example: HEROKU_API_URL=https://pr-manager.herokuapp.com');
        process.exit(1);
    }
    if (!WORKER_API_KEY) {
        logError('ERROR: WORKER_API_KEY environment variable is required');
        process.exit(1);
    }
    if (!process.env.GHE_TOKEN && !process.env.GHE_TOKENS) {
        logError('ERROR: GHE_TOKEN or GHE_TOKENS environment variable is required');
        process.exit(1);
    }
    try {
        // Fetch pending PRs from Heroku
        log(`Fetching pending PRs from ${HEROKU_API_URL}...`);
        const pendingPRs = await fetchPendingPRs();
        log(`Found ${pendingPRs.length} PRs to check`);
        if (pendingPRs.length === 0) {
            log('No PRs need status checking. Done!');
            return;
        }
        // Check each PR
        log('Checking PR status from GitHub Enterprise...');
        const results = [];
        for (const pr of pendingPRs) {
            log(`  Checking ${pr.org}/${pr.repo}#${pr.pr_number}...`);
            const result = await checkPRStatus(pr);
            results.push(result);
            if (result.error) {
                logError(`    ERROR: ${result.error}`);
            }
            else {
                log(`    is_open: ${result.is_open}, has_reviews: ${result.has_reviews}`);
            }
            // Small delay between API calls
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        // Report status back to Heroku
        log('Reporting status to Heroku...');
        const updated = await reportStatus(results);
        log(`Updated ${updated} PRs`);
        // Trigger lesson extraction for newly closed PRs
        const closedPRs = results.filter(r => !r.error && !r.is_open);
        if (closedPRs.length > 0) {
            log(`\n${closedPRs.length} PR(s) detected as closed — triggering lesson extraction...`);
            await triggerLessonExtraction();
        }
        log('Worker completed successfully!');
    }
    catch (error) {
        logError(`Worker error: ${error.message}`);
        if (error.response) {
            logError(`Response status: ${error.response.status}`);
            logError(`Response data: ${JSON.stringify(error.response.data)}`);
        }
        process.exit(1);
    }
}
/**
 * Run in watch mode (continuously every 5 minutes)
 */
async function runWatchMode() {
    log('Starting worker in watch mode (every 5 minutes)...');
    log('Press Ctrl+C to stop.');
    // Run immediately
    await runWorker();
    // Then run every 5 minutes
    setInterval(async () => {
        try {
            await runWorker();
        }
        catch (error) {
            logError(`Worker run failed: ${error}`);
        }
    }, POLL_INTERVAL_MS);
}
// Check if running in watch mode
const isWatchMode = process.argv.includes('--watch') || process.argv.includes('-w');
if (isWatchMode) {
    runWatchMode();
}
else {
    runWorker().then(() => {
        process.exit(0);
    }).catch((error) => {
        logError(`Fatal error: ${error}`);
        process.exit(1);
    });
}
//# sourceMappingURL=localPRChecker.js.map