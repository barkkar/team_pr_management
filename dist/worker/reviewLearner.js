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
- patterns: 2-5 reusable rules. Must reference specific technologies or code patterns. NEVER write generic advice like "be more specific" or "provide actionable feedback".
- review_blind_spots: Which categories did AI systematically miss?
- key_takeaways: 2-4 lessons that reference specific files, classes, or patterns FROM THIS PR. NEVER write "provide actionable feedback" or "be more specific".`;
    const aiComments = (aiReview.comments || [])
        .map((c) => `- [${c.type || 'comment'}] ${c.file_path || 'general'}: ${c.comment}`)
        .join('\n');
    const peerLines = peerComments
        .map(c => `- [${c.reviewer}] ${c.file_path || 'general'}: ${c.body}`)
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
            options: { temperature: 0.3, num_predict: 4096 },
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
        logError(`  LLM lesson generation failed: ${e.message}`);
        return { missed_issues: [], wrong_calls: [], correct_calls: [], patterns: [], review_blind_spots: [], key_takeaways: ['Lesson extraction failed'] };
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
                    missed_issues: [], wrong_calls: [], correct_calls: [],
                    patterns: [], review_blind_spots: [],
                    key_takeaways: ['No peer comments available for comparison'],
                });
                continue;
            }
            // 3. Compare AI review vs peer comments via LLM
            log('  Generating lessons via LLM...');
            const lessons = await generateLessons(review_json, peerComments);
            log(`  Results:`);
            log(`    Missed: ${lessons.missed_issues.length} | Wrong: ${lessons.wrong_calls.length} | Correct: ${lessons.correct_calls.length}`);
            log(`    Patterns: ${(lessons.patterns || []).join('; ')}`);
            log(`    Blind spots: ${(lessons.review_blind_spots || []).join(', ')}`);
            for (const t of lessons.key_takeaways || [])
                log(`    Takeaway: ${t}`);
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