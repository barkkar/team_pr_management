#!/usr/bin/env npx ts-node
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

import 'dotenv/config';
import { notifyError } from '../src/utils/errorNotifier';
import axios from 'axios';
import { Ollama } from 'ollama';
import { requireTokenForHost } from '../src/utils/gheTokenResolver';

const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3-coder';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [BootstrapLearner] ${msg}`);
}

function logError(msg: string, severity: 'warn' | 'error' | 'fatal' = 'error'): void {
  console.error(`[${new Date().toISOString()}] [BootstrapLearner] ${msg}`);
  notifyError('BootstrapLearner', msg, severity);
}

function herokuHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Worker-API-Key': WORKER_API_KEY! };
}

function extractHostname(prUrl: string): string | null {
  const match = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Ollama helpers
// ---------------------------------------------------------------------------

let ollama: Ollama | null = null;
function getOllama(): Ollama {
  if (!ollama) ollama = new Ollama({ host: OLLAMA_HOST });
  return ollama;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const client = getOllama();
  const truncated = text.substring(0, 2000);
  const response = await client.embed({ model: OLLAMA_EMBED_MODEL, input: truncated });
  return response.embeddings[0];
}

// ---------------------------------------------------------------------------
// GHE API helpers
// ---------------------------------------------------------------------------

async function fetchPRDetails(hostname: string, org: string, repo: string, prNumber: number): Promise<any> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`,
    { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }, timeout: 15000 },
  );
  return response.data;
}

async function fetchPRDiff(hostname: string, org: string, repo: string, prNumber: number): Promise<string> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`,
    { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3.diff' }, timeout: 30000 },
  );
  return response.data || '';
}

async function fetchPRFiles(hostname: string, org: string, repo: string, prNumber: number): Promise<any[]> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/files`,
    { params: { per_page: 100 }, headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }, timeout: 15000 },
  );
  return response.data || [];
}

async function fetchPeerComments(hostname: string, org: string, repo: string, prNumber: number): Promise<any[]> {
  const token = requireTokenForHost(hostname);
  const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };
  const base = `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`;
  const comments: any[] = [];

  try {
    const resp = await axios.get(`${base}/comments`, { params: { per_page: 100 }, headers, timeout: 30000 });
    for (const c of resp.data || []) {
      comments.push({
        reviewer: c.user?.login || 'unknown',
        file_path: c.path || null,
        body: (c.body || '').substring(0, 500),
        type: 'inline',
      });
    }
  } catch (e: any) {
    logError(`    Failed to fetch inline comments: ${e.message}`);
  }

  try {
    const resp = await axios.get(`${base}/reviews`, { params: { per_page: 100 }, headers, timeout: 30000 });
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
  } catch (e: any) {
    logError(`    Failed to fetch top-level reviews: ${e.message}`);
  }

  return comments;
}

// ---------------------------------------------------------------------------
// Heroku API helpers (vector search, store results)
// ---------------------------------------------------------------------------

async function fetchSimilarReviews(embedding: number[], topK: number = 10): Promise<any[]> {
  const response = await axios.post(
    `${HEROKU_API_URL}/api/search-similar-reviews`,
    { embedding, top_k: topK },
    { headers: herokuHeaders(), timeout: 30000 },
  );
  return response.data.reviews || [];
}

async function fetchSimilarCode(embedding: number[], topK: number = 5): Promise<any[]> {
  const response = await axios.post(
    `${HEROKU_API_URL}/api/search-similar-code`,
    { embedding, top_k: topK },
    { headers: herokuHeaders(), timeout: 30000 },
  );
  return response.data.chunks || [];
}

async function fetchSimilarDocs(embedding: number[], topK: number = 3): Promise<any[]> {
  try {
    const response = await axios.post(
      `${HEROKU_API_URL}/api/search-similar-docs`,
      { embedding, top_k: topK },
      { headers: herokuHeaders(), timeout: 15000 },
    );
    return response.data.docs || [];
  } catch {
    return [];
  }
}

async function fetchLearningContext(embedding?: number[]): Promise<{ lessons: any[]; feedback: any[] }> {
  try {
    if (embedding && embedding.length > 0) {
      const response = await axios.post(
        `${HEROKU_API_URL}/api/ai-learning-context?limit=5`,
        { embedding },
        { headers: herokuHeaders(), timeout: 15000 },
      );
      return { lessons: response.data.lessons || [], feedback: response.data.feedback || [] };
    }
    const response = await axios.get(
      `${HEROKU_API_URL}/api/ai-learning-context?limit=5`,
      { headers: herokuHeaders(), timeout: 15000 },
    );
    return { lessons: response.data.lessons || [], feedback: response.data.feedback || [] };
  } catch {
    return { lessons: [], feedback: [] };
  }
}

async function reportAnalysisResults(data: {
  pr_url: string; channel_id: string; message_ts: string; review: any; reviewers: any[];
}): Promise<void> {
  await axios.post(`${HEROKU_API_URL}/api/pr-analysis`, data, {
    headers: herokuHeaders(), timeout: 30000,
  });
}

async function reportLessons(prUrl: string, aiReview: any, peerComments: any[], lessons: any, embedding?: number[]): Promise<void> {
  await axios.post(`${HEROKU_API_URL}/api/ai-lessons`, {
    pr_url: prUrl, ai_review: aiReview, peer_comments: peerComments, lessons, embedding,
  }, { headers: herokuHeaders(), timeout: 30000 });
}

// ---------------------------------------------------------------------------
// LLM Prompts (identical to prAnalyzer)
// ---------------------------------------------------------------------------

function reorderDiff(diff: string): string {
  const fileDiffs = diff.split(/^(?=diff --git )/m);
  const newFiles: string[] = [];
  const modifiedFiles: string[] = [];
  for (const fd of fileDiffs) {
    if (!fd.trim()) continue;
    if (fd.includes('new file mode') || fd.includes('--- /dev/null')) {
      newFiles.push(fd);
    } else {
      modifiedFiles.push(fd);
    }
  }
  return [...newFiles, ...modifiedFiles].join('');
}

function buildSystemPrompt(fileCount: number): string {
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

function buildUserPrompt(
  prTitle: string, prDiff: string, changedFiles: string[],
  similarReviews: any[], similarCode: any[],
  learningContext?: { lessons: any[]; feedback: any[] },
  similarDocs?: any[],
): string {
  const parts: string[] = [];

  parts.push(`Review this PR: "${prTitle}"`);
  parts.push(`\nChanged files: ${changedFiles.join(', ')}`);

  if (similarReviews.length > 0) {
    parts.push('\nPast team review comments on similar code:');
    for (const review of similarReviews.slice(0, 5)) {
      parts.push(`- ${review.file_path || 'general'}: "${(review.comment_body || '').substring(0, 300)}"`);
    }
  }

  // Include relevant team design docs / requirements (only if similarity >= 0.75)
  const relevantDocs = (similarDocs || []).filter((d: any) => (d.similarity || 0) >= 0.75);
  if (relevantDocs.length > 0) {
    parts.push('\nTEAM DOCUMENTATION — You MUST check this PR against these team guidelines. If the PR violates or misses any guideline below, produce a comment citing the guideline:');
    for (const doc of relevantDocs.slice(0, 3)) {
      const excerpt = doc.content_chunk.substring(0, 1500);
      parts.push(`--- [${doc.title}] ---\n${excerpt}\n---`);
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
        if (lj.key_takeaway && !lj.key_takeaways) parts.push(`- Lesson: ${lj.key_takeaway}`);
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

function parseReviewResponse(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[1].trim()); } catch { /* fall through */ }
    }
    const braceMatch = content.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try { return JSON.parse(braceMatch[0]); } catch { /* fall through */ }
    }
    return { comments: [], summary: 'Failed to parse LLM response' };
  }
}

function deduplicateComments(review: any): any {
  if (!review?.comments || !Array.isArray(review.comments)) return review;
  const byFile: Record<string, any[]> = {};
  for (const c of review.comments) {
    const key = c.file_path || '__unknown__';
    if (!byFile[key]) byFile[key] = [];
    byFile[key].push(c);
  }
  const dedupedComments: any[] = [];
  for (const [, fileComments] of Object.entries(byFile)) {
    const kept: any[] = [];
    for (const c of fileComments) {
      const commentText = (c.comment || '').toLowerCase();
      const isDuplicate = kept.some(k => {
        const kText = (k.comment || '').toLowerCase();
        return commentText.length > 40 && kText.length > 40 &&
          commentText.substring(0, 40) === kText.substring(0, 40);
      });
      if (!isDuplicate) kept.push(c);
    }
    dedupedComments.push(...kept.slice(0, 3));
  }
  return { ...review, comments: dedupedComments };
}

// ---------------------------------------------------------------------------
// Lesson generation LLM prompt
// ---------------------------------------------------------------------------

async function generateLessonsViaLLM(aiReview: any, peerComments: any[], prDiff: string): Promise<any> {
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
    .map((c: any) => `- [${c.type || 'comment'}] ${c.file_path || 'general'}: ${c.comment}`)
    .join('\n');

  const peerLines = peerComments
    .map((c: any) => `- [${c.reviewer}] ${c.file_path || 'general'}: ${c.body}`)
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
  } catch (e: any) {
    logError(`    LLM lesson generation failed: ${e.message}`);
    return { missed_issues: [], wrong_calls: [], correct_calls: [], patterns: [], review_blind_spots: [], key_takeaways: ['Lesson extraction failed'] };
  }
}

// ---------------------------------------------------------------------------
// Process a single PR: full RAG review + lesson extraction
// ---------------------------------------------------------------------------

async function processPR(pr: any): Promise<boolean> {
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
    const changedFiles = prFiles.map((f: any) => f.filename);
    log(`         "${prTitle}" by ${prAuthor}: ${changedFiles.length} files, ${prDiff.length} chars diff`);

    // 2. Generate embedding
    log('  [4/9] Generating embedding...');
    const fileList = changedFiles.slice(0, 15).join(', ') + (changedFiles.length > 15 ? ` (+${changedFiles.length - 15} more)` : '');
    const diffSummary = `PR: ${prTitle}\nAuthor: ${prAuthor}\nFiles: ${fileList}\n\n${prDiff.substring(0, 1500)}`;
    const diffEmbedding = await generateEmbedding(diffSummary);

    // 3. Vector search
    log('  [5/9] Searching similar reviews + code...');
    let similarReviews: any[] = [];
    try {
      similarReviews = await fetchSimilarReviews(diffEmbedding, 10);
    } catch { /* no results */ }

    let similarCode: any[] = [];
    try {
      similarCode = await fetchSimilarCode(diffEmbedding, 5);
    } catch { /* no results */ }
    log(`         ${similarReviews.length} similar reviews, ${similarCode.length} code chunks`);

    // 4. Fetch learning context + team docs (using embedding for relevance)
    const learningContext = await fetchLearningContext(diffEmbedding);
    const similarDocs = await fetchSimilarDocs(diffEmbedding, 3);

    // 5. Generate AI review via LLM
    log('  [6/9] Generating AI review via Ollama...');
    const client = getOllama();
    const systemPrompt = buildSystemPrompt(changedFiles.length);
    const userPrompt = buildUserPrompt(prTitle, prDiff, changedFiles, similarReviews, similarCode, learningContext, similarDocs);

    let review: any;
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
    } catch (error: any) {
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
    let lessons: any;
    if (peerComments.length === 0) {
      log('  [9/9] No peer comments — storing placeholder lesson...');
      lessons = { missed_issues: [], wrong_calls: [], correct_calls: [], patterns: [], review_blind_spots: [], key_takeaways: ['No peer comments available for comparison'] };
    } else {
      log('  [9/9] Comparing AI vs peer reviews via LLM...');
      lessons = await generateLessonsViaLLM(review, peerComments, prDiff);
      log(`         Missed: ${lessons.missed_issues.length} | Wrong: ${lessons.wrong_calls.length} | Correct: ${lessons.correct_calls.length}`);
      log(`         Patterns: ${(lessons.patterns || []).join('; ')}`);
      log(`         Blind spots: ${(lessons.review_blind_spots || []).join(', ')}`);
      for (const t of lessons.key_takeaways || []) log(`         Takeaway: ${t}`);
    }

    await reportLessons(pr_url, review, peerComments, lessons, diffEmbedding);
    log('  ✅ Complete!');
    return true;
  } catch (error: any) {
    logError(`  ❌ Failed: ${error.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
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
    } else {
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
  } catch (error: any) {
    logError(`Ollama not ready: ${error.message}`);
    logError(`Run: ollama pull ${OLLAMA_EMBED_MODEL} && ollama pull ${OLLAMA_MODEL}`);
    process.exit(1);
  }

  // Fetch closed PRs to process
  log(`\nFetching closed PRs ${force ? '(force re-process)' : 'without lessons'} (limit: ${limit})...`);
  const response = await axios.get(
    `${HEROKU_API_URL}/api/closed-prs-without-lessons?limit=${limit}${force ? '&force=true' : ''}`,
    { headers: herokuHeaders(), timeout: 30000 },
  );
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
    if (ok) succeeded++; else failed++;

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
