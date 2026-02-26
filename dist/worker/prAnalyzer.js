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
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3-coder';
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
    const truncated = text.substring(0, 2000);
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
async function reportAnalysisResults(data) {
    await axios_1.default.post(`${HEROKU_API_URL}/api/pr-analysis`, data, {
        headers: herokuHeaders(),
        timeout: 30000,
    });
}
// ---------------------------------------------------------------------------
// LLM Review Generation
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Multi-pass review helpers
// ---------------------------------------------------------------------------
const TEST_FILE_PATTERN = /(__tests__|test\.js|test\.ts|\.test\.|Test\.java|\/test\/func\/)/i;
const SKIP_FILE_PATTERN = /(\.utam\.json|\.stories\.js|-meta\.xml)$/i;
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
        for (const pattern of (lj.patterns || []).slice(0, 3))
            parts.push(`- Review pattern: ${pattern}`);
        for (const takeaway of (lj.key_takeaways || []).slice(0, 2))
            parts.push(`- Lesson: ${takeaway}`);
        for (const missed of (lj.missed_issues || []).slice(0, 2)) {
            const cat = missed.category ? ` [${missed.category}]` : '';
            const file = missed.file_path ? ` in ${missed.file_path}` : '';
            parts.push(`- Previously missed${cat}${file}: ${missed.issue || missed}`);
        }
        for (const spot of (lj.review_blind_spots || []).slice(0, 3))
            parts.push(`- Blind spot category: ${spot}`);
        if (lj.key_takeaway && !lj.key_takeaways)
            parts.push(`- Lesson: ${lj.key_takeaway}`);
        for (const missed of (lj.ai_missed || []).slice(0, 2))
            parts.push(`- Previously missed: ${missed}`);
    }
    for (const f of feedback.slice(0, 2)) {
        const prefix = f.rating === 'helpful' ? 'Team found helpful' : 'Team found unhelpful';
        parts.push(`- ${prefix}: "${(f.feedback_text || '').substring(0, 200)}"`);
    }
    return parts.join('\n');
}
const JSON_SCHEMA = '\nRespond with JSON: {"summary": "...", "comments": [{"file_path": "...", "line_hint": "...", "comment": "...", "type": "comment|question|suggestion"}]}';
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
function filterLowQualityComment(comment) {
    for (const p of LOW_QUALITY_PATTERNS) {
        if (p.test(comment))
            return null;
    }
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
    const fileList = changedFiles.slice(0, 15).join(', ') + (changedFiles.length > 15 ? ` (+${changedFiles.length - 15} more)` : '');
    const diffSummary = `PR: ${prTitle}\nAuthor: ${prAuthor}\nFiles: ${fileList}\n\n${prDiff.substring(0, 1500)}`;
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
    // 3b. Fetch relevant team docs
    log('  Searching for relevant team docs...');
    const similarDocs = await fetchSimilarDocs(diffEmbedding, 5);
    log(`  Found ${similarDocs.length} relevant doc chunk(s)`);
    // 3c. Fetch learning context (lessons + feedback from similar past reviews)
    log('  Fetching relevant learning context...');
    const learningContext = await fetchLearningContext(diffEmbedding);
    log(`  Got ${learningContext.lessons.length} relevant lesson(s), ${learningContext.feedback.length} feedback item(s)`);
    // 4. Multi-pass LLM review
    log('  Generating AI review via Ollama (3-pass)...');
    const client = getOllama();
    const { implDiff, testDiff, implFiles, testFiles } = splitDiff(prDiff);
    log(`  Split: ${implFiles.length} impl file(s), ${testFiles.length} test file(s)`);
    let allComments = [];
    const summaries = [];
    // Pass 1: Implementation code review
    if (implFiles.length > 0) {
        const p1 = await runReviewPass(client, 'Pass 1: Implementation', pass1_systemPrompt(implFiles.length), pass1_userPrompt(prTitle, implDiff, implFiles, similarReviews, learningContext));
        allComments.push(...(p1.comments || []));
        if (p1.summary)
            summaries.push(p1.summary);
    }
    // Pass 2: Team docs compliance
    const relevantDocs = similarDocs.filter((d) => (d.similarity || 0) >= 0.65);
    if (implFiles.length > 0 && relevantDocs.length > 0) {
        const p2 = await runReviewPass(client, 'Pass 2: Docs Compliance', pass2_systemPrompt(), pass2_userPrompt(prTitle, implDiff, implFiles, relevantDocs));
        allComments.push(...(p2.comments || []));
        if (p2.summary && p2.summary !== 'No guideline violations found')
            summaries.push(p2.summary);
    }
    // Pass 3: Test review
    if (testFiles.length > 0) {
        const p3 = await runReviewPass(client, 'Pass 3: Tests', pass3_systemPrompt(testFiles.length), pass3_userPrompt(prTitle, testDiff, testFiles, implFiles));
        allComments.push(...(p3.comments || []));
        if (p3.summary)
            summaries.push(p3.summary);
    }
    // Filter out comments with hallucinated file paths
    const validPaths = new Set([...implFiles, ...testFiles]);
    const validComments = allComments.filter(c => {
        if (!c.file_path)
            return true;
        if (validPaths.has(c.file_path))
            return true;
        for (const vp of validPaths) {
            if (vp.endsWith(c.file_path) || c.file_path.endsWith(vp.split('/').slice(-2).join('/')))
                return true;
        }
        log(`  Filtered out comment with invalid path: ${c.file_path}`);
        return false;
    });
    const review = deduplicateComments({
        summary: summaries.join(' '),
        comments: validComments,
    });
    log(`  Generated ${review.comments?.length || 0} review comments (merged from 3 passes)`);
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