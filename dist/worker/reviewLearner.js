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
    const systemPrompt = `You are an expert code review analyst comparing an AI-generated code review against actual human peer review comments on the same pull request. You MUST respond with valid JSON only.

Return a JSON object with this EXACT structure:
{
  "missed_issues": [
    {
      "file_path": "path/to/file.ext",
      "issue": "Detailed description of what the peer caught",
      "category": "error_handling|security|performance|naming|testing|architecture|accessibility|documentation|logic_error|style",
      "severity": "high|medium|low",
      "peer_quote": "Relevant quote from peer comment"
    }
  ],
  "wrong_calls": [
    {
      "ai_comment": "What the AI said",
      "why_wrong": "Why it was incorrect, irrelevant, or too generic",
      "category": "false_positive|too_generic|incorrect|irrelevant"
    }
  ],
  "correct_calls": [
    {
      "ai_comment": "What the AI correctly identified",
      "peer_agreed": true
    }
  ],
  "patterns": [
    "Specific, reusable pattern for future reviews (e.g., 'In Java entity classes, always verify @Column nullable/length annotations')"
  ],
  "review_blind_spots": ["category1", "category2"],
  "key_takeaways": [
    "Detailed, actionable takeaway with specific file/pattern references"
  ]
}

Rules:
- missed_issues: Issues peers raised that AI completely missed. Include the specific file, category, and severity. Quote the peer.
- wrong_calls: AI comments that were factually wrong, too generic to be useful, or irrelevant to the actual changes.
- correct_calls: AI comments that aligned with peer feedback.
- patterns: Reusable review rules derived from this comparison. Be specific — mention file types, frameworks, or code patterns. NOT generic advice like "Be more thorough".
- review_blind_spots: Categories where AI consistently missed issues.
- key_takeaways: 2-4 detailed, actionable lessons. Reference specific files, patterns, or issue types. NOT generic advice like "be more specific".`;
    const aiComments = (aiReview.comments || [])
        .map((c) => `- [${c.type || 'comment'}] ${c.file_path || 'general'}: ${c.comment}`)
        .join('\n');
    const peerLines = peerComments
        .map(c => `- [${c.reviewer}] ${c.file_path || 'general'}: ${c.body}`)
        .join('\n');
    const userPrompt = `Compare these two reviews of the same PR.

AI Review (${(aiReview.comments || []).length} comments):
${aiComments || '(no AI comments)'}

AI Summary: ${aiReview.summary || 'N/A'}

Peer Review (${peerComments.length} comments):
${peerLines || '(no peer comments)'}

Analyze what the AI got right, what it missed, and what it got wrong. Derive specific, reusable patterns for future reviews. Respond with the structured JSON.`;
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