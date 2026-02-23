#!/usr/bin/env npx ts-node
"use strict";
/**
 * PR Analyzer
 *
 * Analyzes a single PR using RAG + Ollama LLM:
 *   1. Fetches PR diff + changed files from GHE
 *   2. Generates embeddings for the diff
 *   3. Queries vector DB for similar past reviews and codebase context
 *   4. Calls Ollama LLM to generate review comments
 *   5. Identifies suggested reviewers
 *   6. Reports results back to Heroku for Slack posting
 *
 * Can be run standalone:
 *   npm run analyze-pr -- --pr-url <url>
 *
 * Or triggered by the polling loop in prAnalyzerLoop.
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
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
function log(message) {
    console.log(`[${new Date().toISOString()}] [PRAnalyzer] ${message}`);
}
function logError(message) {
    console.error(`[${new Date().toISOString()}] [PRAnalyzer] ${message}`);
}
function herokuHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-Worker-API-Key': WORKER_API_KEY,
    };
}
function extractHostname(prUrl) {
    const match = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)/);
    return match ? match[1] : null;
}
// ---------------------------------------------------------------------------
// Ollama helpers
// ---------------------------------------------------------------------------
let ollama = null;
function getOllama() {
    if (!ollama) {
        ollama = new ollama_1.Ollama({ host: OLLAMA_HOST });
    }
    return ollama;
}
async function generateEmbedding(text) {
    const client = getOllama();
    const truncated = text.length > 6000 ? text.substring(0, 6000) : text;
    const response = await client.embed({
        model: OLLAMA_EMBED_MODEL,
        input: truncated,
    });
    return response.embeddings[0];
}
// ---------------------------------------------------------------------------
// GHE API helpers
// ---------------------------------------------------------------------------
async function fetchPRDetails(hostname, org, repo, prNumber) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`, {
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
        },
        timeout: 15000,
    });
    return response.data;
}
async function fetchPRDiff(hostname, org, repo, prNumber) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`, {
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3.diff',
        },
        timeout: 30000,
    });
    return response.data || '';
}
async function fetchPRFiles(hostname, org, repo, prNumber) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/files`, {
        params: { per_page: 100 },
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
        },
        timeout: 15000,
    });
    return response.data || [];
}
// ---------------------------------------------------------------------------
// Heroku API: fetch similar context + report results
// ---------------------------------------------------------------------------
async function fetchSimilarReviews(embedding, topK = 10) {
    const response = await axios_1.default.post(`${HEROKU_API_URL}/api/search-similar-reviews`, { embedding, top_k: topK }, { headers: herokuHeaders(), timeout: 30000 });
    return response.data.reviews || [];
}
async function fetchSimilarCode(embedding, topK = 5) {
    const response = await axios_1.default.post(`${HEROKU_API_URL}/api/search-similar-code`, { embedding, top_k: topK }, { headers: herokuHeaders(), timeout: 30000 });
    return response.data.chunks || [];
}
async function fetchSuggestedReviewers(filePaths, prAuthor, similarReviews) {
    const response = await axios_1.default.post(`${HEROKU_API_URL}/api/suggested-reviewers`, { file_paths: filePaths, pr_author: prAuthor, similar_reviews: similarReviews || [] }, { headers: herokuHeaders(), timeout: 30000 });
    return response.data.reviewers || [];
}
async function fetchLearningContext(embedding) {
    try {
        if (embedding && embedding.length > 0) {
            const response = await axios_1.default.post(`${HEROKU_API_URL}/api/ai-learning-context?limit=5`, { embedding }, { headers: herokuHeaders(), timeout: 15000 });
            return { lessons: response.data.lessons || [], feedback: response.data.feedback || [] };
        }
        const response = await axios_1.default.get(`${HEROKU_API_URL}/api/ai-learning-context?limit=5`, { headers: herokuHeaders(), timeout: 15000 });
        return { lessons: response.data.lessons || [], feedback: response.data.feedback || [] };
    }
    catch {
        return { lessons: [], feedback: [] };
    }
}
async function reportAnalysisResults(data) {
    await axios_1.default.post(`${HEROKU_API_URL}/api/pr-analysis`, data, {
        headers: herokuHeaders(),
        timeout: 30000,
    });
}
// ---------------------------------------------------------------------------
// LLM Review Generation
// ---------------------------------------------------------------------------
function buildSystemPrompt() {
    return `You are an expert code reviewer. You MUST respond with valid JSON only. No markdown, no explanations, just JSON.

Review the pull request diff and return a JSON object with this exact structure:

{"summary": "1-2 sentence assessment", "comments": [{"file_path": "path/to/file", "line_hint": "location description", "comment": "your review comment", "type": "suggestion"}]}

Rules for comments:
- type must be one of: "comment", "question", "suggestion"
- Focus on bugs, logic errors, security, performance, missing tests
- Reference past team review patterns when provided
- Be concise and actionable
- Skip trivial style/formatting issues
- Each comment must reference a specific file_path from the PR
- You MUST return at least 1 comment`;
}
function buildUserPrompt(prTitle, prDiff, changedFiles, similarReviews, similarCode, learningContext) {
    const parts = [];
    parts.push(`Review this PR: "${prTitle}"`);
    parts.push(`\nChanged files: ${changedFiles.join(', ')}`);
    if (similarReviews.length > 0) {
        parts.push('\nPast team review comments on similar code:');
        for (const review of similarReviews.slice(0, 5)) {
            parts.push(`- ${review.file_path || 'general'}: "${(review.comment_body || '').substring(0, 300)}"`);
        }
    }
    // Include learning context from past feedback and lessons
    if (learningContext) {
        const { lessons, feedback } = learningContext;
        if (lessons.length > 0 || feedback.length > 0) {
            parts.push('\nLEARNING FROM PAST REVIEWS (apply these patterns):');
            for (const l of lessons.slice(0, 3)) {
                const lj = typeof l.lessons_json === 'string' ? JSON.parse(l.lessons_json) : l.lessons_json;
                // New structured format
                for (const pattern of (lj.patterns || []).slice(0, 3)) {
                    parts.push(`- Review pattern: ${pattern}`);
                }
                for (const takeaway of (lj.key_takeaways || []).slice(0, 2)) {
                    parts.push(`- Lesson: ${takeaway}`);
                }
                for (const missed of (lj.missed_issues || []).slice(0, 2)) {
                    const cat = missed.category ? ` [${missed.category}]` : '';
                    const file = missed.file_path ? ` in ${missed.file_path}` : '';
                    parts.push(`- Previously missed${cat}${file}: ${missed.issue || missed}`);
                }
                for (const spot of (lj.review_blind_spots || []).slice(0, 3)) {
                    parts.push(`- Blind spot category: ${spot}`);
                }
                // Fallback for old format
                if (lj.key_takeaway && !lj.key_takeaways)
                    parts.push(`- Lesson: ${lj.key_takeaway}`);
                for (const missed of (lj.ai_missed || []).slice(0, 2)) {
                    parts.push(`- Previously missed: ${missed}`);
                }
            }
            for (const f of feedback.slice(0, 2)) {
                const prefix = f.rating === 'helpful' ? 'Team found helpful' : 'Team found unhelpful';
                parts.push(`- ${prefix}: "${(f.feedback_text || '').substring(0, 200)}"`);
            }
        }
    }
    // Limit diff to 8000 chars to leave room for LLM response
    parts.push(`\nDiff:\n${prDiff.substring(0, 8000)}`);
    parts.push('\nRespond with JSON: {"summary": "...", "comments": [{"file_path": "...", "line_hint": "...", "comment": "...", "type": "comment|question|suggestion"}]}');
    return parts.join('\n');
}
function parseReviewResponse(content) {
    // Try direct JSON parse
    try {
        return JSON.parse(content);
    }
    catch {
        // Try extracting from markdown fences
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[1].trim());
            }
            catch { /* fall through */ }
        }
        // Try finding JSON object
        const braceMatch = content.match(/\{[\s\S]*\}/);
        if (braceMatch) {
            try {
                return JSON.parse(braceMatch[0]);
            }
            catch { /* fall through */ }
        }
        // Return raw as single comment
        return {
            comments: [{ file_path: null, line_hint: null, comment: content.substring(0, 2000), type: 'comment' }],
            summary: 'AI review generated',
        };
    }
}
// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------
async function analyzePR(prUrl, channelId, messageTs) {
    log(`Analyzing PR: ${prUrl}`);
    const hostname = extractHostname(prUrl);
    if (!hostname) {
        logError(`Cannot extract hostname from ${prUrl}`);
        return;
    }
    // Parse org/repo/number from URL
    const urlMatch = prUrl.match(/\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
    if (!urlMatch) {
        logError(`Cannot parse PR URL: ${prUrl}`);
        return;
    }
    const [, org, repo, prNumberStr] = urlMatch;
    const prNumber = parseInt(prNumberStr, 10);
    // 1. Fetch PR details + diff + files
    log('  Fetching PR details...');
    const prDetails = await fetchPRDetails(hostname, org, repo, prNumber);
    const prTitle = prDetails.title || `PR #${prNumber}`;
    const prAuthor = prDetails.user?.login || '';
    log('  Fetching PR diff...');
    const prDiff = await fetchPRDiff(hostname, org, repo, prNumber);
    log('  Fetching changed files...');
    const prFiles = await fetchPRFiles(hostname, org, repo, prNumber);
    const changedFiles = prFiles.map((f) => f.filename);
    log(`  PR "${prTitle}" by ${prAuthor}: ${changedFiles.length} files changed`);
    // 2. Generate embedding for the PR diff
    log('  Generating embedding for PR diff...');
    const diffSummary = `PR: ${prTitle}\nAuthor: ${prAuthor}\nFiles: ${changedFiles.join(', ')}\n\n${prDiff.substring(0, 4000)}`;
    const diffEmbedding = await generateEmbedding(diffSummary);
    // 3. Search for similar past reviews and codebase context
    log('  Searching for similar past reviews...');
    let similarReviews = [];
    try {
        similarReviews = await fetchSimilarReviews(diffEmbedding, 10);
        log(`  Found ${similarReviews.length} similar past reviews`);
    }
    catch (error) {
        log(`  No similar reviews found: ${error.message}`);
    }
    log('  Searching for related codebase context...');
    let similarCode = [];
    try {
        similarCode = await fetchSimilarCode(diffEmbedding, 5);
        log(`  Found ${similarCode.length} related code chunks`);
    }
    catch (error) {
        log(`  No related code found: ${error.message}`);
    }
    // 3b. Fetch learning context (lessons + feedback from similar past reviews)
    log('  Fetching relevant learning context...');
    const learningContext = await fetchLearningContext(diffEmbedding);
    log(`  Got ${learningContext.lessons.length} relevant lesson(s), ${learningContext.feedback.length} feedback item(s)`);
    // 4. Generate review via LLM
    log('  Generating AI review via Ollama...');
    const client = getOllama();
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(prTitle, prDiff, changedFiles, similarReviews, similarCode, learningContext);
    let review;
    try {
        const response = await client.chat({
            model: OLLAMA_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            format: 'json',
            options: { temperature: 0.3, num_predict: 8192 },
        });
        review = parseReviewResponse(response.message.content.trim());
        log(`  Generated ${review.comments?.length || 0} review comments`);
    }
    catch (error) {
        logError(`  LLM generation failed: ${error.message}`);
        review = { comments: [], summary: `AI review failed: ${error.message}` };
    }
    // 5. Get suggested reviewers
    log('  Finding suggested reviewers...');
    let reviewers = [];
    try {
        reviewers = await fetchSuggestedReviewers(changedFiles, prAuthor, similarReviews);
        log(`  Found ${reviewers.length} suggested reviewers`);
    }
    catch (error) {
        log(`  No reviewer suggestions: ${error.message}`);
    }
    // 6. Report results back to Heroku
    log('  Reporting analysis results...');
    try {
        await reportAnalysisResults({
            pr_url: prUrl,
            channel_id: channelId,
            message_ts: messageTs,
            review,
            reviewers,
        });
        log('  ✅ Analysis complete and reported!');
    }
    catch (error) {
        logError(`  Failed to report results: ${error.message}`);
    }
}
// ---------------------------------------------------------------------------
// Polling mode: check for PRs needing analysis
// ---------------------------------------------------------------------------
async function fetchPRsNeedingAnalysis() {
    const response = await axios_1.default.get(`${HEROKU_API_URL}/api/prs-needing-analysis`, {
        headers: { 'X-Worker-API-Key': WORKER_API_KEY },
        timeout: 30000,
    });
    return response.data.prs || [];
}
async function runAnalysisLoop() {
    log('Checking for PRs needing analysis...');
    const prs = await fetchPRsNeedingAnalysis();
    if (prs.length === 0) {
        log('No PRs need analysis.');
        return;
    }
    log(`Found ${prs.length} PR(s) needing analysis`);
    for (const pr of prs) {
        try {
            await analyzePR(pr.pr_url, pr.channel_id, pr.message_ts);
        }
        catch (error) {
            logError(`Failed to analyze ${pr.pr_url}: ${error.message}`);
        }
    }
}
// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function run() {
    log('='.repeat(60));
    log('PR Analyzer starting...');
    log('='.repeat(60));
    if (!HEROKU_API_URL || !WORKER_API_KEY) {
        logError('HEROKU_API_URL and WORKER_API_KEY are required');
        process.exit(1);
    }
    if (!process.env.GHE_TOKEN && !process.env.GHE_TOKENS) {
        logError('GHE_TOKEN or GHE_TOKENS is required');
        process.exit(1);
    }
    // Verify Ollama
    try {
        const client = getOllama();
        await client.embed({ model: OLLAMA_EMBED_MODEL, input: 'test' });
        log(`Ollama embedding model ready: ${OLLAMA_EMBED_MODEL}`);
        await client.chat({
            model: OLLAMA_MODEL,
            messages: [{ role: 'user', content: 'respond with: ok' }],
            options: { num_predict: 10 },
        });
        log(`Ollama LLM model ready: ${OLLAMA_MODEL}`);
    }
    catch (error) {
        logError(`Ollama not ready: ${error.message}`);
        logError(`Run: ollama pull ${OLLAMA_EMBED_MODEL} && ollama pull ${OLLAMA_MODEL}`);
        process.exit(1);
    }
    // Check if a specific PR URL was passed via CLI
    const prUrlArg = process.argv.find(a => a.startsWith('https://'));
    if (prUrlArg) {
        await analyzePR(prUrlArg, 'manual', '0');
        return;
    }
    // Otherwise run the analysis loop
    await runAnalysisLoop();
}
run().then(() => process.exit(0)).catch((error) => {
    logError(`Fatal error: ${error}`);
    process.exit(1);
});
//# sourceMappingURL=prAnalyzer.js.map