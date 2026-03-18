#!/usr/bin/env npx ts-node
"use strict";
/**
 * Bootstrap Learner
 *
 * Batch processes all closed tracked PRs through the full RAG pipeline:
 *   1. Fetches PR details, diff, files from GHE
 *   2. Generates embeddings via nomic-embed-text
 *   3. Vector search for similar reviews + codebase context
 *   4. Fetches learning context from past lessons/feedback
 *   5. Generates AI review via Ollama LLM (full RAG prompt)
 *   6. Stores AI review in pr_analysis_results
 *   7. Fetches peer review comments from GHE
 *   8. Compares AI vs peer via LLM → structured lessons
 *   9. Stores lessons in ai_review_lessons
 *
 * Usage:
 *   npm run bootstrap-learn              # Process all (default limit: 50)
 *   npm run bootstrap-learn -- --limit 10
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const errorNotifier_1 = require("../src/utils/errorNotifier");
const axios_1 = __importDefault(require("axios"));
const ollama_1 = require("ollama");
const gheTokenResolver_1 = require("../src/utils/gheTokenResolver");
const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3-coder';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
function log(msg) {
    console.log(`[${new Date().toISOString()}] [BootstrapLearner] ${msg}`);
}
function logError(msg, severity = 'error') {
    console.error(`[${new Date().toISOString()}] [BootstrapLearner] ${msg}`);
    (0, errorNotifier_1.notifyError)('BootstrapLearner', msg, severity);
}
function herokuHeaders() {
    return { 'Content-Type': 'application/json', 'X-Worker-API-Key': WORKER_API_KEY };
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
    if (!ollama)
        ollama = new ollama_1.Ollama({ host: OLLAMA_HOST });
    return ollama;
}
async function generateEmbedding(text) {
    const client = getOllama();
    const truncated = text.substring(0, 2000);
    const response = await client.embed({ model: OLLAMA_EMBED_MODEL, input: truncated });
    return response.embeddings[0];
}
// ---------------------------------------------------------------------------
// GHE API helpers
// ---------------------------------------------------------------------------
async function fetchPRDetails(hostname, org, repo, prNumber) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`, { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }, timeout: 15000 });
    return response.data;
}
async function fetchPRDiff(hostname, org, repo, prNumber) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`, { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3.diff' }, timeout: 30000 });
    return response.data || '';
}
async function fetchPRFiles(hostname, org, repo, prNumber) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/files`, { params: { per_page: 100 }, headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }, timeout: 15000 });
    return response.data || [];
}
async function fetchPeerComments(hostname, org, repo, prNumber) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };
    const base = `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`;
    const comments = [];
    try {
        const resp = await axios_1.default.get(`${base}/comments`, { params: { per_page: 100 }, headers, timeout: 30000 });
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
        const resp = await axios_1.default.get(`${base}/reviews`, { params: { per_page: 100 }, headers, timeout: 30000 });
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
// ---------------------------------------------------------------------------
// Skill-based routing: keyword → doc title patterns (derived from skill.md)
// ---------------------------------------------------------------------------
const SKILL_ROUTING = [
    { keywords: /\b(UDD|EntityObject|EntityFunctions|EntityDef|EntityRecord|SOQL|entity[.\-_]xml|object[.\-_]definition|field[.\-_]label|shared[.\-_]labels|CustomObject|CustomField|StandardEntity)\b/i,
        docPattern: 'core-engineer/entity-engineer/%', area: 'Entity/UDD' },
    { keywords: /\b(SDB|SFSQL|PLSQL|psql|db[.\-_]schema|stored[.\-_]procedure|database[.\-_]migration|\.sql)\b/i,
        docPattern: 'core-engineer/db-engineer/%', area: 'Database' },
    { keywords: /\b(ftest|functional[.\-_]test|EntityEnabler|PublicEntityTest|AccessBasedEntityEnablerList|OldTestSuiteEntityAllowList|CRUD[.\-_]test)\b/i,
        docPattern: 'core-engineer/test-engineer/%', area: 'Testing' },
    { keywords: /\b(bazel|buildifier|BUILD\.bazel|db[.\-_]schema[.\-_]update|app[.\-_]server|graph[.\-_]tool)\b/i,
        docPattern: 'core-engineer/infra-engineer/%', area: 'Infrastructure' },
    { keywords: /\b(message[.\-_]queue|MQ[.\-_]handler|async[.\-_]handler|background[.\-_]processing|cron[.\-_]job|scheduled[.\-_]task|QueueableJob|BatchableJob)\b/i,
        docPattern: 'core-engineer/async-engineer/%', area: 'Async/Scheduled' },
    { keywords: /\b(org[.\-_]permission|user[.\-_]permission|feature[.\-_]flag|pilot[.\-_]gate|license[.\-_]check|SKU|access[.\-_]control|PLD)\b/i,
        docPattern: 'core-engineer/permission-engineer/%', area: 'Permissions' },
    { keywords: /\b(LogRecordType|structured[.\-_]logging|app[.\-_]logging[.\-_]format)\b/i,
        docPattern: 'core-engineer/logrecord-engineer/%', area: 'Logging' },
    { keywords: /\b(SpringConfiguration|@Configuration|@Bean|@Import|dependency[.\-_]injection|API[.\-_]Impl|module[.\-_]descriptor)\b/i,
        docPattern: 'core-engineer/module-engineer/%', area: 'Modules' },
    { keywords: /\b(git[.\-_]commit|git[.\-_]push|create[.\-_]PR|p4[.\-_]submit|check[.\-_]in[.\-_]code|submit[.\-_]for[.\-_]review)\b/i,
        docPattern: 'core-engineer/git-engineer/%', area: 'Git' },
];
function matchSkillRoutes(text) {
    const patterns = [];
    const areas = [];
    for (const route of SKILL_ROUTING) {
        if (route.keywords.test(text)) {
            patterns.push(route.docPattern);
            areas.push(route.area);
        }
    }
    return { patterns, areas };
}
// ---------------------------------------------------------------------------
// GHE: fetch full file content for context
// ---------------------------------------------------------------------------
async function fetchFileContent(hostname, org, repo, filePath, ref) {
    try {
        const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
        const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/contents/${filePath}`, {
            params: { ref },
            headers: {
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github.v3+json',
            },
            timeout: 10000,
        });
        if (response.data.encoding === 'base64') {
            return Buffer.from(response.data.content, 'base64').toString('utf-8');
        }
        return response.data.content || null;
    }
    catch {
        return null;
    }
}
function buildFileContextSummary(files) {
    const parts = [];
    for (const file of files) {
        const lines = file.content.split('\n');
        const fingerprint = [`File: ${file.path}`];
        // Extract imports/requires (first 30 lines)
        const importLines = lines.slice(0, 30).filter(l => /^\s*(import |from |require\(|#include|using |package |@import)/.test(l));
        if (importLines.length > 0) {
            fingerprint.push('Imports: ' + importLines.slice(0, 10).join('; '));
        }
        // Extract class/function/component declarations
        const declLines = lines.filter(l => /^\s*(export\s+)?(public\s+|private\s+|protected\s+)?(class |interface |function |const \w+ = |def |type |enum |abstract |@api|@wire|@track|@AuraEnabled)/.test(l)).slice(0, 8);
        if (declLines.length > 0) {
            fingerprint.push('Declarations: ' + declLines.map(l => l.trim()).join('; '));
        }
        parts.push(fingerprint.join('\n'));
    }
    // Cap at 2000 chars for embedding model input
    return parts.join('\n\n').substring(0, 2000);
}
// ---------------------------------------------------------------------------
// Heroku API helpers (vector search, store results)
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
async function fetchDocsByTitlePattern(embedding, patterns, topK = 5) {
    try {
        if (patterns.length === 0)
            return [];
        const response = await axios_1.default.post(`${HEROKU_API_URL}/api/search-docs-by-title`, { embedding, patterns, top_k: topK }, { headers: herokuHeaders(), timeout: 15000 });
        return response.data.docs || [];
    }
    catch {
        return [];
    }
}
async function fetchOntologyRules(changedFiles, diffText) {
    try {
        const response = await axios_1.default.post(`${HEROKU_API_URL}/api/resolve-rules`, { changed_files: changedFiles, diff_text: diffText.substring(0, 50000) }, { headers: herokuHeaders(), timeout: 30000 });
        return {
            rules: response.data.rules || [],
            taxonomy: response.data.taxonomy || [],
            unmatched_files: response.data.unmatched_files || [],
        };
    }
    catch (error) {
        log(`  Ontology rule resolution failed: ${error.message}`);
        return { rules: [], taxonomy: [], unmatched_files: changedFiles };
    }
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
        headers: herokuHeaders(), timeout: 30000,
    });
}
async function reportLessons(prUrl, aiReview, peerComments, lessons, embedding) {
    await axios_1.default.post(`${HEROKU_API_URL}/api/ai-lessons`, {
        pr_url: prUrl, ai_review: aiReview, peer_comments: peerComments, lessons, embedding,
    }, { headers: herokuHeaders(), timeout: 30000 });
}
// ---------------------------------------------------------------------------
// LLM Prompts (identical to prAnalyzer)
// ---------------------------------------------------------------------------
function reorderDiff(diff) {
    const fileDiffs = diff.split(/^(?=diff --git )/m);
    const newFiles = [];
    const modifiedFiles = [];
    for (const fd of fileDiffs) {
        if (!fd.trim())
            continue;
        if (fd.includes('new file mode') || fd.includes('--- /dev/null')) {
            newFiles.push(fd);
        }
        else {
            modifiedFiles.push(fd);
        }
    }
    return [...newFiles, ...modifiedFiles].join('');
}
function buildSystemPrompt(fileCount) {
    const minComments = Math.max(3, Math.min(fileCount, 10));
    return `You are an expert code reviewer. You MUST respond with valid JSON only. No markdown, no explanations, just JSON.

Review the pull request diff and return a JSON object with this exact structure:

{"summary": "1-2 sentence assessment", "comments": [{"file_path": "path/to/file", "line_hint": "location description", "comment": "your review comment", "type": "suggestion"}]}

Rules:
- type must be one of: "comment", "question", "suggestion"
- Focus on: bugs, security issues, performance, logic errors, edge cases, error handling, naming conventions, missing null checks, accessibility (for UI code), test coverage gaps
- Reference past team review patterns and LEARNING CONTEXT when provided — apply those lessons to THIS PR
- If TEAM DOCUMENTATION is provided, you MUST check the PR against those guidelines and produce at least one comment referencing a team doc guideline when the PR relates to the documented topic
- NEVER write vague comments like "ensure this is correct" or "ensure this doesn't break". Every comment MUST identify a SPECIFIC potential issue, bug, or violation with a concrete explanation of what could go wrong
- Maximum 3 comments per file — pick the most important issues per file
- For test files: comment on missing test coverage or test quality, NOT on individual test cases. Do NOT say tests are "unnecessary" or "redundant" unless you can prove they duplicate another specific test
- Skip trivial style/formatting issues
- Each comment must reference a specific file_path from the PR
- You MUST return at least ${minComments} comments — review EVERY changed file, not just the first few
- Spread comments across different files — do not focus on just one file
- Prioritize reviewing implementation files (.js, .ts, .java, .html) over test files
- For each file, look for: missing error handling, potential null/undefined, security issues, logic bugs, naming issues, missing tests`;
}
function buildUserPrompt(prTitle, prDiff, changedFiles, similarReviews, similarCode, learningContext, similarDocs) {
    const parts = [];
    parts.push(`Review this PR: "${prTitle}"`);
    parts.push(`\nChanged files: ${changedFiles.join(', ')}`);
    if (similarReviews.length > 0) {
        parts.push('\nPast team review comments on similar code:');
        for (const review of similarReviews.slice(0, 5)) {
            parts.push(`- ${review.file_path || 'general'}: "${(review.comment_body || '').substring(0, 300)}"`);
        }
    }
    // Include ontology rules (exact deterministic matches)
    const relevantRules = (similarDocs || []);
    if (relevantRules.length > 0) {
        parts.push('\nCODING RULES — You MUST check this PR against these exact rules. If the PR violates or misses any rule below, produce a comment citing the rule:');
        for (const rule of relevantRules.slice(0, 10)) {
            if (rule.rule_key) {
                // Ontology rule format
                const severityTag = rule.severity ? `[${rule.severity.toUpperCase()}]` : '';
                parts.push(`--- [${rule.title}] (${rule.rule_key}) ${severityTag} ---\n${(rule.description || '').substring(0, 1000)}\n---`);
            }
            else if (rule.content_chunk) {
                // Legacy doc chunk format (fallback)
                parts.push(`--- [${rule.title}] ---\n${rule.content_chunk.substring(0, 1500)}\n---`);
            }
        }
    }
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
    const orderedDiff = reorderDiff(prDiff);
    parts.push(`\nDiff (new files listed first):\n${orderedDiff.substring(0, 16000)}`);
    parts.push('\nRespond with JSON: {"summary": "...", "comments": [{"file_path": "...", "line_hint": "...", "comment": "...", "type": "comment|question|suggestion"}]}');
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
        return { comments: [], summary: 'Failed to parse LLM response' };
    }
}
function deduplicateComments(review) {
    if (!review?.comments || !Array.isArray(review.comments))
        return review;
    const byFile = {};
    for (const c of review.comments) {
        const key = c.file_path || '__unknown__';
        if (!byFile[key])
            byFile[key] = [];
        byFile[key].push(c);
    }
    const dedupedComments = [];
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
        dedupedComments.push(...kept.slice(0, 3));
    }
    return { ...review, comments: dedupedComments };
}
// ---------------------------------------------------------------------------
// Lesson generation LLM prompt
// ---------------------------------------------------------------------------
async function generateLessonsViaLLM(aiReview, peerComments, prDiff) {
    const client = getOllama();
    const peerCount = peerComments.length;
    const aiCount = (aiReview.comments || []).length;
    const systemPrompt = `You are an expert code review analyst. You MUST compare an AI code review against actual human peer review comments on the same PR. You have the PR diff for reference. Respond with valid JSON ONLY.

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
    "Specific reusable rule, e.g. 'In LWC components, always check wire service error handling' or 'In Java entity classes, verify @Column nullable annotations'"
  ],
  "review_blind_spots": ["category1", "category2"],
  "key_takeaways": [
    "Detailed takeaway referencing specific files and patterns from THIS PR"
  ]
}

Rules:
- missed_issues: List ALL peer comments that AI missed, one entry per distinct issue. If peers left 10 comments and AI left 3, expect at least 5-7 missed issues. Each must include the actual file_path from the diff and a direct peer_quote.
- wrong_calls: List ALL AI comments that were wrong, too vague, or irrelevant. An AI comment like "consider adding tests" when tests already exist is wrong. "Consider error handling" without specifying where is too_generic.
- correct_calls: AI comments that genuinely matched peer concerns.
- patterns: 2-5 reusable rules. Must reference specific technologies (LWC, Java, Apex, JSP, etc.) or code patterns (null checks, event handlers, schema validation). NEVER write generic advice like "be more specific" or "provide actionable feedback".
- review_blind_spots: Which categories did AI systematically miss?
- key_takeaways: 2-4 lessons that reference specific files, classes, or patterns FROM THIS PR. NEVER write "provide actionable feedback" or "be more specific" — those are useless. Instead: "AI missed all naming convention issues in LWC component files — future reviews should check component names match directory names".`;
    const aiComments = (aiReview.comments || [])
        .map((c) => `- [${c.type || 'comment'}] ${c.file_path || 'general'}: ${c.comment}`)
        .join('\n');
    const peerLines = peerComments
        .map((c) => `- [${c.reviewer}] ${c.file_path || 'general'}: ${c.body}`)
        .join('\n');
    const diffExcerpt = prDiff.substring(0, 6000);
    const userPrompt = `Here is a PR with ${peerCount} peer comments and ${aiCount} AI comments. The AI likely missed many issues. Find ALL of them.

PR Diff (excerpt):
${diffExcerpt}

AI Review (${aiCount} comments):
${aiComments || '(no AI comments)'}

AI Summary: ${aiReview.summary || 'N/A'}

Peer Review (${peerCount} comments):
${peerLines || '(no peer comments)'}

For EACH peer comment above, determine: did the AI catch this issue? If not, add it to missed_issues with the exact file_path and a direct quote. Then check each AI comment: was it actually useful or too generic? Finally, derive specific reusable patterns (mentioning actual technologies like LWC, Java, Apex, etc). Respond with JSON.`;
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
// ---------------------------------------------------------------------------
// Process a single PR: full RAG review + lesson extraction
// ---------------------------------------------------------------------------
async function processPR(pr) {
    const { pr_url, org, repo, pr_number, channel_id, message_ts } = pr;
    log(`\n${'─'.repeat(60)}`);
    log(`Processing ${org}/${repo}#${pr_number}`);
    const hostname = extractHostname(pr_url);
    if (!hostname) {
        logError(`  Cannot extract hostname from ${pr_url}`);
        return false;
    }
    try {
        // 1. Fetch PR details, diff, files
        log('  [1/9] Fetching PR details...');
        const prDetails = await fetchPRDetails(hostname, org, repo, pr_number);
        const prTitle = prDetails.title || `PR #${pr_number}`;
        const prAuthor = prDetails.user?.login || '';
        log('  [2/9] Fetching PR diff...');
        const prDiff = await fetchPRDiff(hostname, org, repo, pr_number);
        log('  [3/9] Fetching changed files...');
        const prFiles = await fetchPRFiles(hostname, org, repo, pr_number);
        const changedFiles = prFiles.map((f) => f.filename);
        log(`         "${prTitle}" by ${prAuthor}: ${changedFiles.length} files, ${prDiff.length} chars diff`);
        // 2. Generate embedding
        log('  [4/9] Generating embedding...');
        const fileList = changedFiles.slice(0, 15).join(', ') + (changedFiles.length > 15 ? ` (+${changedFiles.length - 15} more)` : '');
        const diffSummary = `PR: ${prTitle}\nAuthor: ${prAuthor}\nFiles: ${fileList}\n\n${prDiff.substring(0, 1500)}`;
        const diffEmbedding = await generateEmbedding(diffSummary);
        // 3. Vector search
        log('  [5/9] Searching similar reviews + code...');
        let similarReviews = [];
        try {
            similarReviews = await fetchSimilarReviews(diffEmbedding, 10);
        }
        catch { /* no results */ }
        let similarCode = [];
        try {
            similarCode = await fetchSimilarCode(diffEmbedding, 5);
        }
        catch { /* no results */ }
        log(`         ${similarReviews.length} similar reviews, ${similarCode.length} code chunks`);
        // 4. Fetch full file content for context-aware doc matching
        log('  [5b/9] Fetching full file content for doc matching...');
        const headSha = prDetails.head?.sha || '';
        const implPrFiles = prFiles
            .filter((f) => !(/(__tests__|test\.js|test\.ts|\.test\.|Test\.java|\/test\/func\/)/i.test(f.filename))
            && !(/(\.utam\.json|\.stories\.js|-meta\.xml)$/i.test(f.filename)))
            .sort((a, b) => (b.additions || 0) - (a.additions || 0))
            .slice(0, 8);
        const fileContents = [];
        for (const f of implPrFiles) {
            const content = await fetchFileContent(hostname, org, repo, f.filename, headSha);
            if (content) {
                fileContents.push({ path: f.filename, content });
            }
        }
        log(`         Fetched ${fileContents.length}/${implPrFiles.length} file(s) for context`);
        let fileContextEmbedding = diffEmbedding;
        if (fileContents.length > 0) {
            const fileContextSummary = buildFileContextSummary(fileContents);
            fileContextEmbedding = await generateEmbedding(fileContextSummary);
        }
        // 4b. Ontology-based rule resolution
        const ontologyResult = await fetchOntologyRules(changedFiles, prDiff);
        const cappedDocs = ontologyResult.rules;
        log(`         Ontology resolved ${ontologyResult.rules.length} rules (${ontologyResult.unmatched_files.length} unmatched files)`);
        // 4c. Fetch learning context
        const learningContext = await fetchLearningContext(diffEmbedding);
        // 5. Generate AI review via LLM
        log('  [6/9] Generating AI review via Ollama...');
        const client = getOllama();
        const systemPrompt = buildSystemPrompt(changedFiles.length);
        const userPrompt = buildUserPrompt(prTitle, prDiff, changedFiles, similarReviews, similarCode, learningContext, cappedDocs);
        let review;
        try {
            const response = await client.chat({
                model: OLLAMA_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
                format: 'json',
                options: { temperature: 0.3, num_predict: 8192, num_ctx: 32768 },
            });
            review = deduplicateComments(parseReviewResponse(response.message.content.trim()));
            log(`         Generated ${review.comments?.length || 0} review comments`);
        }
        catch (error) {
            logError(`         LLM review failed: ${error.message}`);
            review = { comments: [], summary: `AI review failed: ${error.message}` };
        }
        // 6. Store AI review
        log('  [7/9] Storing AI review...');
        await reportAnalysisResults({
            pr_url, channel_id: channel_id || 'bootstrap', message_ts: message_ts || '0',
            review, reviewers: [],
        });
        // 7. Fetch peer review comments
        log('  [8/9] Fetching peer review comments...');
        const peerComments = await fetchPeerComments(hostname, org, repo, pr_number);
        log(`         ${peerComments.length} peer comment(s)`);
        // 8-9. Compare AI vs peer + store lessons
        let lessons;
        if (peerComments.length === 0) {
            log('  [9/9] No peer comments — storing placeholder lesson...');
            lessons = { missed_issues: [], wrong_calls: [], correct_calls: [], patterns: [], review_blind_spots: [], key_takeaways: ['No peer comments available for comparison'] };
        }
        else {
            log('  [9/9] Comparing AI vs peer reviews via LLM...');
            lessons = await generateLessonsViaLLM(review, peerComments, prDiff);
            log(`         Missed: ${lessons.missed_issues.length} | Wrong: ${lessons.wrong_calls.length} | Correct: ${lessons.correct_calls.length}`);
            log(`         Patterns: ${(lessons.patterns || []).join('; ')}`);
            log(`         Blind spots: ${(lessons.review_blind_spots || []).join(', ')}`);
            for (const t of lessons.key_takeaways || [])
                log(`         Takeaway: ${t}`);
        }
        await reportLessons(pr_url, review, peerComments, lessons, diffEmbedding);
        log('  ✅ Complete!');
        return true;
    }
    catch (error) {
        logError(`  ❌ Failed: ${error.message}`);
        return false;
    }
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
    log('='.repeat(60));
    log('Bootstrap Learner starting...');
    log('='.repeat(60));
    if (!HEROKU_API_URL || !WORKER_API_KEY) {
        logError('HEROKU_API_URL and WORKER_API_KEY are required');
        process.exit(1);
    }
    if (!process.env.GHE_TOKEN && !process.env.GHE_TOKENS) {
        logError('GHE_TOKEN or GHE_TOKENS is required');
        process.exit(1);
    }
    // Parse --limit flag
    const limitArg = process.argv.find(a => a.startsWith('--limit'));
    let limit = 50;
    if (limitArg) {
        const parts = limitArg.split('=');
        if (parts.length === 2) {
            limit = parseInt(parts[1], 10);
        }
        else {
            const idx = process.argv.indexOf(limitArg);
            if (idx >= 0 && process.argv[idx + 1]) {
                limit = parseInt(process.argv[idx + 1], 10);
            }
        }
    }
    // Parse --force flag (re-process PRs that already have lessons)
    const force = process.argv.includes('--force');
    if (force) {
        log('⚠️  Force mode: re-processing PRs that already have lessons');
    }
    // Verify Ollama
    log('Verifying Ollama models...');
    try {
        const client = getOllama();
        await client.embed({ model: OLLAMA_EMBED_MODEL, input: 'test' });
        log(`  ✓ Embedding model ready: ${OLLAMA_EMBED_MODEL}`);
        await client.chat({
            model: OLLAMA_MODEL,
            messages: [{ role: 'user', content: 'respond with: ok' }],
            options: { num_predict: 10 },
        });
        log(`  ✓ LLM model ready: ${OLLAMA_MODEL}`);
    }
    catch (error) {
        logError(`Ollama not ready: ${error.message}`);
        logError(`Run: ollama pull ${OLLAMA_EMBED_MODEL} && ollama pull ${OLLAMA_MODEL}`);
        process.exit(1);
    }
    // Fetch closed PRs to process
    log(`\nFetching closed PRs ${force ? '(force re-process)' : 'without lessons'} (limit: ${limit})...`);
    const response = await axios_1.default.get(`${HEROKU_API_URL}/api/closed-prs-without-lessons?limit=${limit}${force ? '&force=true' : ''}`, { headers: herokuHeaders(), timeout: 30000 });
    const prs = response.data.prs || [];
    if (prs.length === 0) {
        log('No closed PRs need processing. Done!');
        return;
    }
    log(`Found ${prs.length} closed PR(s) to process\n`);
    let succeeded = 0;
    let failed = 0;
    for (let i = 0; i < prs.length; i++) {
        log(`\n[${i + 1}/${prs.length}]`);
        const ok = await processPR(prs[i]);
        if (ok)
            succeeded++;
        else
            failed++;
        // Delay between PRs to avoid hammering APIs
        if (i < prs.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
    log('\n' + '='.repeat(60));
    log(`Bootstrap Learner complete!`);
    log(`  Processed: ${prs.length} | Succeeded: ${succeeded} | Failed: ${failed}`);
    log('='.repeat(60));
}
run().then(() => process.exit(0)).catch((error) => {
    logError(`Fatal error: ${error}`);
    process.exit(1);
});
//# sourceMappingURL=bootstrapLearner.js.map