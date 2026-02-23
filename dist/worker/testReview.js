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
    const truncated = text.length > 6000 ? text.substring(0, 6000) : text;
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
async function fetchSuggestedReviewers(filePaths, prAuthor) {
    const response = await axios_1.default.post(`${HEROKU_API_URL}/api/suggested-reviewers`, { file_paths: filePaths, pr_author: prAuthor }, { headers: herokuHeaders(), timeout: 30000 });
    return response.data.reviewers || [];
}
// ---------------------------------------------------------------------------
// LLM Prompts
// ---------------------------------------------------------------------------
function buildSystemPrompt() {
    return `You are an expert code reviewer for a software engineering team. Your task is to review a pull request diff and provide helpful, constructive review comments.

You have access to:
1. The PR diff (files changed)
2. Similar past review comments from the team's history
3. Codebase knowledge about the repository

Guidelines:
- Focus on substantive issues: bugs, logic errors, security concerns, performance problems
- Reference past review patterns when relevant
- Ask clarifying questions when intent is unclear
- Suggest improvements based on codebase conventions
- Be concise and actionable
- Do NOT comment on trivial formatting or style unless it deviates significantly from codebase conventions

Output your review as a JSON object with this structure:
{
  "comments": [
    {
      "file_path": "path/to/file.ts",
      "line_hint": "brief description of the code location",
      "comment": "your review comment",
      "type": "comment|question|suggestion"
    }
  ],
  "summary": "1-2 sentence overall assessment"
}

Respond ONLY with the JSON object, no markdown fences or other text.`;
}
function buildUserPrompt(prTitle, prDiff, changedFiles, similarReviews, similarCode) {
    const parts = [];
    parts.push(`## Pull Request: ${prTitle}`);
    parts.push(`\n### Changed Files:\n${changedFiles.map(f => `- ${f}`).join('\n')}`);
    if (similarReviews.length > 0) {
        parts.push('\n### Relevant Past Review Comments (from team history):');
        for (const review of similarReviews.slice(0, 5)) {
            parts.push(`\n**${review.org}/${review.repo}** - ${review.file_path || 'general'}:`);
            parts.push(`> ${(review.comment_body || '').substring(0, 500)}`);
        }
    }
    if (similarCode.length > 0) {
        parts.push('\n### Related Codebase Context:');
        for (const code of similarCode.slice(0, 3)) {
            parts.push(`\n**${code.file_path}:**`);
            parts.push(`\`\`\`\n${(code.content_chunk || '').substring(0, 1000)}\n\`\`\``);
        }
    }
    parts.push('\n### PR Diff:');
    parts.push(`\`\`\`diff\n${prDiff.substring(0, 15000)}\n\`\`\``);
    return parts.join('\n');
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
    const diffSummary = `PR: ${prTitle}\nAuthor: ${prAuthor}\nFiles: ${changedFiles.join(', ')}\n\n${prDiff.substring(0, 4000)}`;
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
    // 4. LLM review
    separator('5. AI REVIEW (via Ollama)');
    log(`Generating review with ${OLLAMA_MODEL}... (this may take a minute)`);
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(prTitle, prDiff, changedFiles, similarReviews, similarCode);
    let review;
    try {
        const client = getOllama();
        const response = await client.chat({
            model: OLLAMA_MODEL,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            options: { temperature: 0.3, num_predict: 4096 },
        });
        const rawResponse = response.message.content.trim();
        review = parseReviewResponse(rawResponse);
        console.log(`\n  Summary: ${review.summary || 'N/A'}\n`);
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
    }
    catch (error) {
        logError(`LLM generation failed: ${error.message}`);
        review = { comments: [], summary: `Failed: ${error.message}` };
    }
    // 5. Suggested reviewers
    separator('6. SUGGESTED REVIEWERS');
    try {
        const reviewers = await fetchSuggestedReviewers(changedFiles, prAuthor);
        if (reviewers.length === 0) {
            console.log('  No reviewer suggestions (not enough review history yet)');
        }
        else {
            for (let i = 0; i < reviewers.length; i++) {
                const r = reviewers[i];
                console.log(`  [${i + 1}] ${r.ghe_login}${r.slack_user_id ? ` (Slack: <@${r.slack_user_id}>)` : ''}`);
                console.log(`      Score: ${r.score}  Reviews: ${r.review_count || 0}  File touches: ${r.file_touch_count || 0}`);
            }
        }
    }
    catch (error) {
        console.log(`  Could not fetch reviewer suggestions: ${error.message}`);
    }
    separator('DONE');
    console.log('  This was a dry run — nothing was saved or posted to Slack.\n');
}
run().then(() => process.exit(0)).catch((error) => {
    logError(`Fatal error: ${error}`);
    process.exit(1);
});
//# sourceMappingURL=testReview.js.map