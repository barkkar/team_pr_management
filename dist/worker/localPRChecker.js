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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const axios_1 = __importDefault(require("axios"));
const ollama_1 = require("ollama");
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
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
    const peerCount = peerComments.length;
    const aiCount = (aiReview.comments || []).length;
    const systemPrompt = `You are an expert code review analyst. You MUST compare an AI code review against actual human peer review comments on the same PR. Respond with valid JSON ONLY.

CRITICAL: Be EXHAUSTIVE. List EVERY missed issue, not just one representative example. If peers left ${peerCount} comments and AI left ${aiCount}, there are likely multiple missed issues.

Return JSON with this structure:
{
  "missed_issues": [
    {
      "file_path": "path/to/file.ext",
      "issue": "Detailed description of what the peer caught",
      "category": "error_handling|security|performance|naming|testing|architecture|accessibility|documentation|logic_error|style",
      "severity": "high|medium|low",
      "peer_quote": "Direct quote from the peer comment"
    }
  ],
  "wrong_calls": [
    {
      "ai_comment": "The exact AI comment that was wrong",
      "why_wrong": "Specific reason it was wrong (reference the code)",
      "category": "false_positive|too_generic|incorrect|irrelevant"
    }
  ],
  "correct_calls": [
    {
      "ai_comment": "The AI comment that was correct",
      "peer_agreed": true
    }
  ],
  "patterns": [
    "Specific reusable rule, e.g. 'In LWC components, always check wire service error handling'"
  ],
  "review_blind_spots": ["category1", "category2"],
  "key_takeaways": [
    "Detailed takeaway referencing specific files and patterns from THIS PR"
  ]
}

Rules:
- missed_issues: List ALL peer comments that AI missed, one entry per distinct issue. Each must include the actual file_path and a direct peer_quote.
- wrong_calls: List ALL AI comments that were wrong, too vague, or irrelevant.
- correct_calls: AI comments that genuinely matched peer concerns.
- patterns: 2-5 reusable rules. Must reference specific technologies or code patterns. NEVER write generic advice like "be more specific".
- review_blind_spots: Which categories did AI systematically miss?
- key_takeaways: 2-4 lessons that reference specific files, classes, or patterns FROM THIS PR. NEVER write "provide actionable feedback" or "be more specific".`;
    const aiComments = (aiReview.comments || [])
        .map((c) => `- [${c.type || 'comment'}] ${c.file_path || 'general'}: ${c.comment}`)
        .join('\n');
    const peerLines = peerComments
        .map((c) => `- [${c.reviewer}] ${c.file_path || 'general'}: ${c.body}`)
        .join('\n');
    const userPrompt = `Here is a PR with ${peerCount} peer comments and ${aiCount} AI comments. The AI likely missed many issues. Find ALL of them.

AI Review (${aiCount} comments):
${aiComments || '(no AI comments)'}

AI Summary: ${aiReview.summary || 'N/A'}

Peer Review (${peerCount} comments):
${peerLines || '(no peer comments)'}

For EACH peer comment above, determine: did the AI catch this issue? If not, add it to missed_issues with the exact file_path and a direct quote. Then check each AI comment: was it actually useful or too generic? Finally, derive specific reusable patterns. Respond with JSON.`;
    try {
        const response = await client.chat({
            model: OLLAMA_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            format: 'json',
            options: { temperature: 0.3, num_predict: 4096, num_ctx: 32768 },
        });
        const parsed = JSON.parse(response.message.content.trim());
        return {
            missed_issues: Array.isArray(parsed.missed_issues) ? parsed.missed_issues : [],
            wrong_calls: Array.isArray(parsed.wrong_calls) ? parsed.wrong_calls : [],
            correct_calls: Array.isArray(parsed.correct_calls) ? parsed.correct_calls : [],
            patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
            review_blind_spots: Array.isArray(parsed.review_blind_spots) ? parsed.review_blind_spots : [],
            key_takeaways: Array.isArray(parsed.key_takeaways) ? parsed.key_takeaways : [String(parsed.key_takeaway || '')],
        };
    }
    catch (e) {
        logError(`    LLM lesson generation failed: ${e.message}`);
        return { missed_issues: [], wrong_calls: [], correct_calls: [], patterns: [], review_blind_spots: [], key_takeaways: ['Lesson extraction failed'] };
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
                lessons = { missed_issues: [], wrong_calls: [], correct_calls: [], patterns: [], review_blind_spots: [], key_takeaways: ['No peer comments available for comparison'] };
            }
            else {
                log('    Generating lessons via LLM...');
                lessons = await generateLessons(review_json, peerComments);
                for (const t of lessons.key_takeaways || [])
                    log(`    Takeaway: ${t}`);
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
 * Trigger AI analysis by spawning prAnalyzer as a child process
 */
async function triggerAnalysis() {
    return new Promise((resolve) => {
        const analyzerPath = path.join(__dirname, 'prAnalyzer.js');
        log(`Spawning PR analyzer: ${analyzerPath}`);
        const child = (0, child_process_1.spawn)('node', [analyzerPath], {
            stdio: 'inherit',
            env: process.env,
        });
        child.on('close', (code) => {
            if (code === 0) {
                log('AI analysis completed successfully');
            }
            else {
                logError(`AI analysis exited with code ${code}`);
            }
            resolve();
        });
        child.on('error', (err) => {
            logError(`Failed to spawn analyzer: ${err.message}`);
            resolve();
        });
    });
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
        if (pendingPRs.length > 0) {
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
        }
        else {
            log('No PRs need status checking.');
        }
        // Always trigger AI analysis for PRs needing review
        log('\nTriggering AI analysis for new PRs...');
        await triggerAnalysis();
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