#!/usr/bin/env npx ts-node
"use strict";
/**
 * Test Review (dry-run)
 *
 * Runs the full AI review pipeline for a given PR URL and logs results
 * to the console. Nothing is saved to the database or posted to Slack.
 *
 * Usage:
 *   npm run test-review -- https://git.soma.salesforce.com/org/repo/pull/123
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
    console.log(`[TestReview] ${message}`);
}
function logError(message) {
    console.error(`[TestReview] ERROR: ${message}`);
}
function herokuHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-Worker-API-Key': WORKER_API_KEY,
    };
}
function extractHostname(prUrl) {
    const match = prUrl.match(/https:\/\/([a-zA-Z0-9.-]+)/);
    return match ? match[1] : null;
}
function separator(title) {
    console.log('\n' + '='.repeat(70));
    console.log(`  ${title}`);
    console.log('='.repeat(70));
}
// ---------------------------------------------------------------------------
// Ollama
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
    const truncated = text.substring(0, 2000);
    const response = await client.embed({
        model: OLLAMA_EMBED_MODEL,
        input: truncated,
    });
    return response.embeddings[0];
}
// ---------------------------------------------------------------------------
// GHE API
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
// Heroku API (read-only queries)
// ---------------------------------------------------------------------------
async function fetchSimilarReviews(embedding, topK = 10) {
    const response = await axios_1.default.post(`${HEROKU_API_URL}/api/search-similar-reviews`, { embedding, top_k: topK }, { headers: herokuHeaders(), timeout: 30000 });
    return response.data.reviews || [];
}
async function fetchSimilarCode(embedding, topK = 5) {
    const response = await axios_1.default.post(`${HEROKU_API_URL}/api/search-similar-code`, { embedding, top_k: topK }, { headers: herokuHeaders(), timeout: 30000 });
    return response.data.chunks || [];
}
async function fetchSimilarDocs(embedding, topK = 3) {
    try {
        const response = await axios_1.default.post(`${HEROKU_API_URL}/api/search-similar-docs`, { embedding, top_k: topK }, { headers: herokuHeaders(), timeout: 15000 });
        return response.data.docs || [];
    }
    catch {
        return [];
    }
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
// ---------------------------------------------------------------------------
// LLM Prompts
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Multi-pass review helpers
// ---------------------------------------------------------------------------
const TEST_FILE_PATTERN = /(__tests__|test\.js|test\.ts|\.test\.|Test\.java|\/test\/func\/)/i;
const SKIP_FILE_PATTERN = /(\.utam\.json|\.stories\.js|-meta\.xml)$/i;
/**
 * Split diff into implementation files and test files.
 * New files are reordered to appear first within each group.
 */
function splitDiff(diff) {
    const fileDiffs = diff.split(/^(?=diff --git )/m);
    const implNew = [];
    const implMod = [];
    const testNew = [];
    const testMod = [];
    const implFiles = [];
    const testFiles = [];
    for (const fd of fileDiffs) {
        if (!fd.trim())
            continue;
        const pathMatch = fd.match(/diff --git a\/(\S+)/);
        const filePath = pathMatch ? pathMatch[1] : '';
        const isNew = fd.includes('new file mode') || fd.includes('--- /dev/null');
        const isSkip = SKIP_FILE_PATTERN.test(filePath);
        const isTest = TEST_FILE_PATTERN.test(filePath);
        if (isSkip) {
            // Skip metadata files (utam, stories, meta-xml) — not worth reviewing
            continue;
        }
        else if (isTest) {
            testFiles.push(filePath);
            (isNew ? testNew : testMod).push(fd);
        }
        else {
            implFiles.push(filePath);
            (isNew ? implNew : implMod).push(fd);
        }
    }
    return {
        implDiff: [...implNew, ...implMod].join(''),
        testDiff: [...testNew, ...testMod].join(''),
        implFiles,
        testFiles,
    };
}
function buildLearningContextBlock(learningContext) {
    if (!learningContext)
        return '';
    const { lessons, feedback } = learningContext;
    if (lessons.length === 0 && feedback.length === 0)
        return '';
    const parts = ['\nLEARNING FROM PAST REVIEWS — You MUST apply these lessons to THIS PR:'];
    for (const l of lessons.slice(0, 3)) {
        const lj = typeof l.lessons_json === 'string' ? JSON.parse(l.lessons_json) : l.lessons_json;
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
    return parts.join('\n');
}
const JSON_SCHEMA = '\nRespond with JSON: {"summary": "...", "comments": [{"file_path": "...", "line_hint": "...", "comment": "...", "type": "comment|question|suggestion"}]}';
// --- Pass 1: Implementation code review (bugs, logic, security, naming) ---
function pass1_systemPrompt(fileCount) {
    const minComments = Math.max(2, Math.min(fileCount, 8));
    return `You are an expert code reviewer reviewing IMPLEMENTATION files only (no test files). Respond with valid JSON only.

{"summary": "1-2 sentence assessment", "comments": [{"file_path": "path/to/file", "line_hint": "location", "comment": "your comment", "type": "suggestion"}]}

Rules:
- type: "comment", "question", or "suggestion"
- Focus on: bugs, security, performance, logic errors, edge cases, error handling, null checks, accessibility
- NEVER write vague comments. These phrases are BANNED: "ensure this is correct", "consider using", "not properly handling", "add validation", "could be improved", "not properly scoped". Instead say EXACTLY what is wrong: what input causes what failure
- Do NOT suggest renaming variables or elements for "readability" — skip trivial style/naming issues
- Do NOT comment on CSS scoping — LWC components use shadow DOM which auto-scopes CSS
- Do NOT repeat the same comment pattern across different files. Each comment must be unique
- ONLY use file_path values from the provided file list. Do NOT invent or guess file paths
- Maximum 3 comments per file
- You MUST return at least ${minComments} comments spread across different files
- For each file: look for missing error handling, null/undefined access, security issues, logic bugs, race conditions, missing edge cases`;
}
function pass1_userPrompt(prTitle, implDiff, implFiles, similarReviews, learningContext) {
    const parts = [];
    parts.push(`Review these IMPLEMENTATION files from PR: "${prTitle}"`);
    parts.push(`\nFiles: ${implFiles.join(', ')}`);
    if (similarReviews.length > 0) {
        parts.push('\nPast team review comments on similar code:');
        for (const r of similarReviews.slice(0, 5)) {
            parts.push(`- ${r.file_path || 'general'}: "${(r.comment_body || '').substring(0, 300)}"`);
        }
    }
    parts.push(buildLearningContextBlock(learningContext));
    parts.push(`\nDiff:\n${implDiff.substring(0, 28000)}`);
    parts.push(JSON_SCHEMA);
    return parts.join('\n');
}
// --- Pass 2: Team docs / code rules compliance check ---
function pass2_systemPrompt() {
    return `You are a compliance reviewer checking implementation code against team documentation and coding guidelines. Respond with valid JSON only.

{"summary": "1-2 sentence compliance assessment", "comments": [{"file_path": "path/to/file", "line_hint": "location", "comment": "your comment", "type": "suggestion"}]}

Rules:
- For each team guideline provided, check if the implementation follows it
- If the code VIOLATES a guideline, cite the guideline name and explain what's wrong
- If the code MISSES a required pattern from the guidelines, call it out
- NEVER write vague comments. Be specific: "Per [doc name], you should X but the code does Y"
- Only comment on genuine violations — do not force-fit unrelated guidelines
- If no guidelines are violated, return {"summary": "No guideline violations found", "comments": []}`;
}
function pass2_userPrompt(prTitle, implDiff, implFiles, similarDocs) {
    const parts = [];
    parts.push(`Check this PR against team guidelines: "${prTitle}"`);
    parts.push(`\nFiles: ${implFiles.join(', ')}`);
    parts.push('\nTEAM GUIDELINES — check the code against each of these:');
    for (const doc of similarDocs.slice(0, 5)) {
        const excerpt = doc.content_chunk.substring(0, 1500);
        parts.push(`--- [${doc.title}] (${doc.doc_type || 'guide'}) ---\n${excerpt}\n---`);
    }
    parts.push(`\nDiff:\n${implDiff.substring(0, 20000)}`);
    parts.push(JSON_SCHEMA);
    return parts.join('\n');
}
// --- Pass 3: Test file review ---
function pass3_systemPrompt(testFileCount) {
    const minComments = Math.max(2, Math.min(testFileCount, 5));
    return `You are an expert test reviewer reviewing ONLY test files. Respond with valid JSON only.

{"summary": "1-2 sentence test assessment", "comments": [{"file_path": "path/to/file", "line_hint": "location", "comment": "your comment", "type": "suggestion"}]}

Rules:
- Focus on: missing test coverage for implementation code, edge cases not tested, assertion quality, mock correctness
- Do NOT comment on individual test cases being "unnecessary" or "redundant"
- Identify MISSING scenarios: what error paths, boundary conditions, or edge cases SHOULD be tested but aren't?
- NEVER write vague comments. Name the SPECIFIC scenario missing, e.g. "No test for when X is null/empty"
- These phrases are BANNED: "consider adding", "could be improved", "ensure". State the missing test case directly
- ONLY use file_path values from the provided test file list. Do NOT invent file paths
- Do NOT comment on .utam.json or .stories.js files — only review actual test files (.test.js, .test.ts)
- Maximum 3 comments per test file
- You MUST return at least ${minComments} comments across different test files
- Cross-reference implementation files to find untested branches and error handling`;
}
function pass3_userPrompt(prTitle, testDiff, testFiles, implFiles) {
    const parts = [];
    parts.push(`Review test files for PR: "${prTitle}"`);
    parts.push(`\nTest files: ${testFiles.join(', ')}`);
    parts.push(`\nImplementation files being tested: ${implFiles.join(', ')}`);
    parts.push(`\nTest diff:\n${testDiff.substring(0, 28000)}`);
    parts.push(JSON_SCHEMA);
    return parts.join('\n');
}
// --- LLM call helper ---
async function runReviewPass(client, passName, systemPrompt, userPrompt) {
    try {
        log(`  [${passName}] Running...`);
        const response = await client.chat({
            model: OLLAMA_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            format: 'json',
            options: { temperature: 0.3, num_predict: 4096, num_ctx: 32768 },
        });
        const raw = response.message.content.trim();
        const parsed = parseReviewResponse(raw);
        const result = deduplicateComments(parsed);
        log(`  [${passName}] ${result.comments?.length || 0} comments`);
        return result;
    }
    catch (error) {
        logError(`  [${passName}] Failed: ${error.message}`);
        return { comments: [], summary: `${passName} failed: ${error.message}` };
    }
}
function parseReviewResponse(content) {
    try {
        return JSON.parse(content);
    }
    catch {
        const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[1].trim());
            }
            catch { /* fall through */ }
        }
        const braceMatch = content.match(/\{[\s\S]*\}/);
        if (braceMatch) {
            try {
                return JSON.parse(braceMatch[0]);
            }
            catch { /* fall through */ }
        }
        return {
            comments: [{ file_path: null, line_hint: null, comment: content.substring(0, 2000), type: 'comment' }],
            summary: 'AI review generated',
        };
    }
}
// Banned patterns — LLM outputs these despite prompt rules; filter programmatically
const LOW_QUALITY_PATTERNS = [
    /not properly scoped/i,
    /not properly handling/i,
    /could be improved/i,
    /\bcss\b.*\bscop/i, // "CSS ... scoping/scoped"
    /\bwhen X is\b/i, // Literal prompt example copied
];
const VAGUE_PHRASE_PATTERNS = [
    /^consider (using|adding|fetching|implementing)/i,
    /^add (a simple |proper )?validation/i,
    /^ensure (this|that|the)/i,
];
/**
 * Filter out low-quality comments that match known bad patterns.
 * Returns the comment text cleaned of leading vague phrases, or null if the entire comment is bad.
 */
function filterLowQualityComment(comment) {
    // Reject entirely if matches a hard-ban pattern
    for (const p of LOW_QUALITY_PATTERNS) {
        if (p.test(comment))
            return null;
    }
    // Strip leading vague phrases if the rest has substance (>30 chars)
    let result = comment;
    for (const p of VAGUE_PHRASE_PATTERNS) {
        if (p.test(result)) {
            const stripped = result.replace(p, '').trim().replace(/^[.,;:\-\u2013\u2014]\s*/, '');
            if (stripped.length > 30) {
                result = stripped.charAt(0).toUpperCase() + stripped.slice(1);
            }
            else {
                return null;
            }
        }
    }
    // Remove mid-sentence "Consider [verb]ing ..." trailing sentences
    result = result.replace(/\.\s*Consider \w+ing[^.]*\.?\s*$/i, '.').trim();
    return result.length > 15 ? result : null;
}
/**
 * Compute word-level overlap ratio between two strings (Jaccard similarity on word sets).
 */
function wordOverlap(a, b) {
    const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 3));
    const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 3));
    if (wordsA.size === 0 || wordsB.size === 0)
        return 0;
    let intersection = 0;
    for (const w of wordsA) {
        if (wordsB.has(w))
            intersection++;
    }
    return intersection / Math.min(wordsA.size, wordsB.size);
}
/**
 * Post-process review: filter low quality, cap to 3 per file, deduplicate.
 */
function deduplicateComments(review) {
    if (!review?.comments || !Array.isArray(review.comments))
        return review;
    // Phase 0: filter low-quality comments
    const quality = [];
    for (const c of review.comments) {
        const cleaned = filterLowQualityComment(c.comment || '');
        if (cleaned !== null) {
            quality.push({ ...c, comment: cleaned });
        }
    }
    // Phase 1: per-file dedup + cap at 3
    const byFile = {};
    for (const c of quality) {
        const key = c.file_path || '__unknown__';
        if (!byFile[key])
            byFile[key] = [];
        byFile[key].push(c);
    }
    const perFileDeduped = [];
    for (const [, fileComments] of Object.entries(byFile)) {
        const kept = [];
        for (const c of fileComments) {
            const commentText = (c.comment || '').toLowerCase();
            const isDuplicate = kept.some(k => {
                const kText = (k.comment || '').toLowerCase();
                return commentText.length > 40 && kText.length > 40 &&
                    commentText.substring(0, 40) === kText.substring(0, 40);
            });
            if (!isDuplicate)
                kept.push(c);
        }
        perFileDeduped.push(...kept.slice(0, 3));
    }
    // Phase 2: cross-file dedup using word overlap (Jaccard > 0.6 = duplicate pattern)
    const dedupedComments = [];
    for (const c of perFileDeduped) {
        const isCrossFileDup = dedupedComments.some(k => wordOverlap(c.comment || '', k.comment || '') > 0.6);
        if (!isCrossFileDup)
            dedupedComments.push(c);
    }
    return { ...review, comments: dedupedComments };
}
// ---------------------------------------------------------------------------
// Slack message formatter (mirrors formatSlackAnalysis in src/index.ts)
// ---------------------------------------------------------------------------
function formatSlackMessage(review, reviewers) {
    const blocks = [];
    blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: ':robot_face: *AI Review Intelligence*' },
    });
    const comments = review?.comments || [];
    if (comments.length > 0) {
        const commentsByType = { comment: [], question: [], suggestion: [] };
        for (const c of comments) {
            const t = c.type || 'comment';
            if (!commentsByType[t])
                commentsByType[t] = [];
            commentsByType[t].push(c);
        }
        if (commentsByType.comment.length > 0) {
            const lines = commentsByType.comment.map((c) => {
                const prefix = c.file_path ? `\`${c.file_path}\`` : '';
                const hint = c.line_hint ? ` (${c.line_hint})` : '';
                return `• ${prefix}${hint} ${c.comment}`;
            }).join('\n');
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:memo: *Review Comments:*\n${lines}` } });
        }
        if (commentsByType.question.length > 0) {
            const lines = commentsByType.question.map((c) => {
                const prefix = c.file_path ? `\`${c.file_path}\`` : '';
                return `• ${prefix} ${c.comment}`;
            }).join('\n');
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:question: *Questions:*\n${lines}` } });
        }
        if (commentsByType.suggestion.length > 0) {
            const lines = commentsByType.suggestion.map((c) => {
                const prefix = c.file_path ? `\`${c.file_path}\`` : '';
                return `• ${prefix} ${c.comment}`;
            }).join('\n');
            blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:bulb: *Suggestions:*\n${lines}` } });
        }
    }
    else {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No specific review comments generated._' } });
    }
    if (review?.summary) {
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*Summary:* ${review.summary}` }] });
    }
    blocks.push({ type: 'divider' });
    if (reviewers && reviewers.length > 0) {
        const mentionList = reviewers.map((r) => r.slack_user_id ? `<@${r.slack_user_id}>` : `\`${r.ghe_login}\``);
        const mentionStr = mentionList.length === 1
            ? mentionList[0]
            : mentionList.slice(0, -1).join(', ') + ' and ' + mentionList[mentionList.length - 1];
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:eyes: Hey ${mentionStr}, could you take a look at this PR?` } });
        const reasonLines = reviewers.map((r) => {
            const mention = r.slack_user_id ? `<@${r.slack_user_id}>` : `\`${r.ghe_login}\``;
            return `• ${mention} — ${r.reason}`;
        }).join('\n');
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: reasonLines }] });
    }
    else {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No reviewer suggestions available yet._' } });
    }
    // Feedback solicitation
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ':speech_balloon: Was this review helpful? Your feedback helps improve future suggestions.' }] });
    blocks.push({
        type: 'actions',
        elements: [
            { type: 'button', text: { type: 'plain_text', text: ':thumbsup: Helpful', emoji: true }, action_id: 'ai_review_helpful', value: 'pr_url', style: 'primary' },
            { type: 'button', text: { type: 'plain_text', text: ':thumbsdown: Not Helpful', emoji: true }, action_id: 'ai_review_not_helpful', value: 'pr_url' },
        ],
    });
    const text = `:robot_face: AI Review Intelligence — ${comments.length} comment(s), ${reviewers?.length || 0} reviewer suggestion(s)`;
    return { text, blocks };
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
    const prUrl = process.argv.find(a => a.startsWith('https://'));
    if (!prUrl) {
        console.log('Usage: npm run test-review -- https://git.soma.salesforce.com/org/repo/pull/123');
        process.exit(1);
    }
    if (!HEROKU_API_URL || !WORKER_API_KEY) {
        logError('HEROKU_API_URL and WORKER_API_KEY are required');
        process.exit(1);
    }
    const hostname = extractHostname(prUrl);
    if (!hostname) {
        logError(`Cannot extract hostname from ${prUrl}`);
        process.exit(1);
    }
    const urlMatch = prUrl.match(/\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
    if (!urlMatch) {
        logError(`Cannot parse PR URL: ${prUrl}`);
        process.exit(1);
    }
    const [, org, repo, prNumberStr] = urlMatch;
    const prNumber = parseInt(prNumberStr, 10);
    // Verify Ollama
    log('Checking Ollama...');
    try {
        const client = getOllama();
        await client.embed({ model: OLLAMA_EMBED_MODEL, input: 'test' });
        log(`Embedding model ready: ${OLLAMA_EMBED_MODEL}`);
        await client.chat({
            model: OLLAMA_MODEL,
            messages: [{ role: 'user', content: 'respond with: ok' }],
            options: { num_predict: 10 },
        });
        log(`LLM model ready: ${OLLAMA_MODEL}`);
    }
    catch (error) {
        logError(`Ollama not ready: ${error.message}`);
        logError(`Run: ollama pull ${OLLAMA_EMBED_MODEL} && ollama pull ${OLLAMA_MODEL}`);
        process.exit(1);
    }
    // 1. Fetch PR info
    separator('1. PR DETAILS');
    log('Fetching PR details...');
    const prDetails = await fetchPRDetails(hostname, org, repo, prNumber);
    const prTitle = prDetails.title || `PR #${prNumber}`;
    const prAuthor = prDetails.user?.login || '';
    const prState = prDetails.state;
    const prMerged = prDetails.merged;
    console.log(`  Title:    ${prTitle}`);
    console.log(`  Author:   ${prAuthor}`);
    console.log(`  State:    ${prState}${prMerged ? ' (merged)' : ''}`);
    console.log(`  URL:      ${prUrl}`);
    log('Fetching changed files...');
    const prFiles = await fetchPRFiles(hostname, org, repo, prNumber);
    const changedFiles = prFiles.map((f) => f.filename);
    console.log(`  Files:    ${changedFiles.length} changed`);
    for (const f of changedFiles) {
        const file = prFiles.find((pf) => pf.filename === f);
        console.log(`            ${f}  (+${file?.additions || 0} -${file?.deletions || 0})`);
    }
    log('Fetching PR diff...');
    const prDiff = await fetchPRDiff(hostname, org, repo, prNumber);
    console.log(`  Diff size: ${prDiff.length} chars`);
    // 2. Generate embedding
    separator('2. EMBEDDING');
    log('Generating embedding for PR diff...');
    const fileList = changedFiles.slice(0, 15).join(', ') + (changedFiles.length > 15 ? ` (+${changedFiles.length - 15} more)` : '');
    const diffSummary = `PR: ${prTitle}\nAuthor: ${prAuthor}\nFiles: ${fileList}\n\n${prDiff.substring(0, 1500)}`;
    const diffEmbedding = await generateEmbedding(diffSummary);
    console.log(`  Embedding dimensions: ${diffEmbedding.length}`);
    // 3. Vector search
    separator('3. SIMILAR PAST REVIEWS');
    let similarReviews = [];
    try {
        similarReviews = await fetchSimilarReviews(diffEmbedding, 10);
        console.log(`  Found ${similarReviews.length} similar past reviews:\n`);
        for (let i = 0; i < similarReviews.length; i++) {
            const r = similarReviews[i];
            console.log(`  [${i + 1}] ${r.org}/${r.repo} PR#${r.pr_number} — ${r.file_path || 'general'}`);
            console.log(`      Reviewer: ${r.reviewer_login}  State: ${r.review_state}`);
            console.log(`      Comment: ${(r.comment_body || '').substring(0, 200)}`);
            if (r.similarity !== undefined) {
                console.log(`      Similarity: ${r.similarity}`);
            }
            console.log('');
        }
    }
    catch (error) {
        console.log(`  No similar reviews found: ${error.message}`);
    }
    separator('4. RELATED CODEBASE CONTEXT');
    let similarCode = [];
    try {
        similarCode = await fetchSimilarCode(diffEmbedding, 5);
        console.log(`  Found ${similarCode.length} related code chunks:\n`);
        for (let i = 0; i < similarCode.length; i++) {
            const c = similarCode[i];
            console.log(`  [${i + 1}] ${c.file_path}`);
            console.log(`      ${(c.content_chunk || '').substring(0, 150).replace(/\n/g, '\n      ')}`);
            console.log('');
        }
    }
    catch (error) {
        console.log(`  No related code found: ${error.message}`);
    }
    // 4. Learning context
    separator('5. LEARNING CONTEXT');
    let learningContext = { lessons: [], feedback: [] };
    try {
        learningContext = await fetchLearningContext(diffEmbedding);
        console.log(`  ${learningContext.lessons.length} relevant lesson(s), ${learningContext.feedback.length} feedback item(s)`);
        for (const l of learningContext.lessons) {
            const lj = typeof l.lessons_json === 'string' ? JSON.parse(l.lessons_json) : l.lessons_json;
            const similarity = l.similarity ? ` (similarity: ${(l.similarity * 100).toFixed(1)}%)` : '';
            for (const t of (lj.key_takeaways || []))
                console.log(`  - Takeaway${similarity}: ${t}`);
            if (lj.key_takeaway && !lj.key_takeaways)
                console.log(`  - Takeaway${similarity}: ${lj.key_takeaway}`);
        }
        for (const f of learningContext.feedback) {
            console.log(`  - ${f.rating}: "${(f.feedback_text || '').substring(0, 100)}"`);
        }
        if (learningContext.lessons.length === 0 && learningContext.feedback.length === 0) {
            console.log('  No learning context yet — will improve as PRs are reviewed and closed.');
        }
    }
    catch (error) {
        console.log(`  Could not fetch learning context: ${error.message}`);
    }
    // 4b. Similar docs
    separator('5b. TEAM DOCS');
    const similarDocs = await fetchSimilarDocs(diffEmbedding, 5);
    console.log(`  Found ${similarDocs.length} relevant doc chunk(s)`);
    for (const d of similarDocs) {
        console.log(`  - [${d.title}] (similarity: ${((d.similarity || 0) * 100).toFixed(1)}%) ${d.content_chunk.substring(0, 100)}...`);
    }
    // 5. Multi-pass LLM review
    separator('6. AI REVIEW — MULTI-PASS (via Ollama)');
    log(`Generating review with ${OLLAMA_MODEL} (3-pass)...`);
    // Split diff into implementation and test files
    const { implDiff, testDiff, implFiles, testFiles } = splitDiff(prDiff);
    console.log(`  Split: ${implFiles.length} implementation file(s), ${testFiles.length} test file(s)`);
    console.log(`  Impl diff: ${implDiff.length} chars (sending first 24000)`);
    console.log(`  Test diff: ${testDiff.length} chars (sending first 24000)\n`);
    const client = getOllama();
    let allComments = [];
    const summaries = [];
    // --- Pass 1: Implementation code review ---
    separator('6a. PASS 1 — Implementation Review');
    if (implFiles.length > 0) {
        const p1 = await runReviewPass(client, 'Pass 1: Implementation', pass1_systemPrompt(implFiles.length), pass1_userPrompt(prTitle, implDiff, implFiles, similarReviews, learningContext));
        allComments.push(...(p1.comments || []));
        if (p1.summary)
            summaries.push(p1.summary);
        for (const c of (p1.comments || [])) {
            console.log(`    [${c.type}] ${c.file_path}: ${c.comment.substring(0, 120)}...`);
        }
    }
    else {
        console.log('  No implementation files to review.');
    }
    // --- Pass 2: Team docs / code rules compliance ---
    separator('6b. PASS 2 — Team Docs Compliance');
    const relevantDocs = similarDocs.filter((d) => (d.similarity || 0) >= 0.65);
    if (implFiles.length > 0 && relevantDocs.length > 0) {
        const p2 = await runReviewPass(client, 'Pass 2: Docs Compliance', pass2_systemPrompt(), pass2_userPrompt(prTitle, implDiff, implFiles, relevantDocs));
        allComments.push(...(p2.comments || []));
        if (p2.summary && p2.summary !== 'No guideline violations found')
            summaries.push(p2.summary);
        for (const c of (p2.comments || [])) {
            console.log(`    [${c.type}] ${c.file_path}: ${c.comment.substring(0, 120)}...`);
        }
    }
    else {
        console.log(`  Skipped — ${relevantDocs.length === 0 ? 'no relevant team docs found (similarity < 65%)' : 'no implementation files'}`);
    }
    // --- Pass 3: Test file review ---
    separator('6c. PASS 3 — Test Review');
    if (testFiles.length > 0) {
        const p3 = await runReviewPass(client, 'Pass 3: Tests', pass3_systemPrompt(testFiles.length), pass3_userPrompt(prTitle, testDiff, testFiles, implFiles));
        allComments.push(...(p3.comments || []));
        if (p3.summary)
            summaries.push(p3.summary);
        for (const c of (p3.comments || [])) {
            console.log(`    [${c.type}] ${c.file_path}: ${c.comment.substring(0, 120)}...`);
        }
    }
    else {
        console.log('  No test files to review.');
    }
    // Filter out comments with hallucinated file paths
    const validPaths = new Set([...implFiles, ...testFiles]);
    const validComments = allComments.filter(c => {
        if (!c.file_path)
            return true;
        if (validPaths.has(c.file_path))
            return true;
        // Fuzzy match: check if any valid path ends with the comment's path
        for (const vp of validPaths) {
            if (vp.endsWith(c.file_path) || c.file_path.endsWith(vp.split('/').slice(-2).join('/')))
                return true;
        }
        log(`  Filtered out comment with invalid path: ${c.file_path}`);
        return false;
    });
    // Merge and deduplicate all pass results
    const mergedReview = deduplicateComments({
        summary: summaries.join(' '),
        comments: validComments,
    });
    const review = mergedReview;
    separator('6d. MERGED RESULTS');
    console.log(`  Summary: ${review.summary || 'N/A'}\n`);
    const comments = review.comments || [];
    console.log(`  ${comments.length} review comment(s):\n`);
    for (let i = 0; i < comments.length; i++) {
        const c = comments[i];
        console.log(`  --- Comment ${i + 1} [${c.type || 'comment'}] ---`);
        if (c.file_path)
            console.log(`  File: ${c.file_path}`);
        if (c.line_hint)
            console.log(`  Location: ${c.line_hint}`);
        console.log(`  ${c.comment}`);
        console.log('');
    }
    // 5. Suggested reviewers
    separator('7. SUGGESTED REVIEWERS');
    let reviewers = [];
    try {
        reviewers = await fetchSuggestedReviewers(changedFiles, prAuthor, similarReviews);
        if (reviewers.length === 0) {
            console.log('  No reviewer suggestions (not enough review history yet)');
        }
        else {
            for (let i = 0; i < reviewers.length; i++) {
                const r = reviewers[i];
                console.log(`  [${i + 1}] ${r.ghe_login}${r.slack_user_id ? ` (Slack: <@${r.slack_user_id}>)` : ''}`);
                console.log(`      Score: ${r.score}  Reason: ${r.reason || 'N/A'}`);
            }
        }
    }
    catch (error) {
        console.log(`  Could not fetch reviewer suggestions: ${error.message}`);
    }
    // 6. Slack message preview
    separator('8. SLACK MESSAGE PREVIEW');
    const slackMessage = formatSlackMessage(review, reviewers);
    console.log('  Below is what would be posted as a Slack thread reply:\n');
    console.log('  ┌─────────────────────────────────────────────────────────┐');
    for (const block of slackMessage.blocks) {
        if (block.type === 'divider') {
            console.log('  │ ─────────────────────────────────────────────────────── │');
        }
        else if (block.type === 'section' && block.text?.text) {
            const lines = block.text.text.split('\n');
            for (const line of lines) {
                console.log(`  │ ${line}`);
            }
        }
        else if (block.type === 'context' && block.elements) {
            for (const el of block.elements) {
                console.log(`  │ ${el.text}`);
            }
        }
    }
    console.log('  └─────────────────────────────────────────────────────────┘');
    // Post to Slack if --post flag is passed
    const shouldPost = process.argv.includes('--post');
    const postChannel = process.argv.find(a => a.startsWith('--channel='))?.split('=')[1];
    if (shouldPost) {
        separator('9. POSTING TO SLACK');
        const slackToken = process.env.SLACK_BOT_TOKEN;
        if (!slackToken) {
            logError('SLACK_BOT_TOKEN is required to post. Skipping Slack post.');
        }
        else if (!postChannel) {
            logError('Provide --channel=CHANNEL_ID to post. Example: --post --channel=C0123456');
        }
        else {
            log(`Posting to channel ${postChannel}...`);
            try {
                const postResp = await axios_1.default.post('https://slack.com/api/chat.postMessage', {
                    channel: postChannel,
                    text: slackMessage.text,
                    blocks: slackMessage.blocks,
                }, {
                    headers: {
                        Authorization: `Bearer ${slackToken}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 15000,
                });
                if (postResp.data.ok) {
                    log(`✅ Posted to Slack! ts=${postResp.data.ts}`);
                }
                else {
                    logError(`Slack API error: ${postResp.data.error}`);
                }
            }
            catch (error) {
                logError(`Failed to post to Slack: ${error.message}`);
            }
        }
    }
    separator('DONE');
    if (!shouldPost) {
        console.log('  This was a dry run — nothing was saved or posted to Slack.');
        console.log('  To post to Slack, re-run with: --post --channel=CHANNEL_ID\n');
    }
}
run().then(() => process.exit(0)).catch((error) => {
    logError(`Fatal error: ${error}`);
    process.exit(1);
});
//# sourceMappingURL=testReview.js.map