#!/usr/bin/env npx ts-node
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

import 'dotenv/config';
import axios from 'axios';
import { Ollama } from 'ollama';
import { requireTokenForHost } from '../src/utils/gheTokenResolver';

const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [PRAnalyzer] ${message}`);
}

function logError(message: string): void {
  console.error(`[${new Date().toISOString()}] [PRAnalyzer] ${message}`);
}

function herokuHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Worker-API-Key': WORKER_API_KEY!,
  };
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
  if (!ollama) {
    ollama = new Ollama({ host: OLLAMA_HOST });
  }
  return ollama;
}

async function generateEmbedding(text: string): Promise<number[]> {
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

async function fetchPRDetails(hostname: string, org: string, repo: string, prNumber: number): Promise<any> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      timeout: 15000,
    },
  );
  return response.data;
}

async function fetchPRDiff(hostname: string, org: string, repo: string, prNumber: number): Promise<string> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3.diff',
      },
      timeout: 30000,
    },
  );
  return response.data || '';
}

async function fetchPRFiles(hostname: string, org: string, repo: string, prNumber: number): Promise<any[]> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/files`,
    {
      params: { per_page: 100 },
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      timeout: 15000,
    },
  );
  return response.data || [];
}

// ---------------------------------------------------------------------------
// Heroku API: fetch similar context + report results
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

async function fetchSuggestedReviewers(filePaths: string[], prAuthor: string, similarReviews?: any[]): Promise<any[]> {
  const response = await axios.post(
    `${HEROKU_API_URL}/api/suggested-reviewers`,
    { file_paths: filePaths, pr_author: prAuthor, similar_reviews: similarReviews || [] },
    { headers: herokuHeaders(), timeout: 30000 },
  );
  return response.data.reviewers || [];
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
  pr_url: string;
  channel_id: string;
  message_ts: string;
  review: any;
  reviewers: any[];
}): Promise<void> {
  await axios.post(`${HEROKU_API_URL}/api/pr-analysis`, data, {
    headers: herokuHeaders(),
    timeout: 30000,
  });
}

// ---------------------------------------------------------------------------
// LLM Review Generation
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return `You are an expert code reviewer. You MUST respond with valid JSON only. No markdown, no explanations, just JSON.

Review the pull request diff and return a JSON object with this exact structure:

{"summary": "1-2 sentence assessment", "comments": [{"file_path": "path/to/file", "line_hint": "location description", "comment": "your review comment", "type": "suggestion"}]}

Rules for comments:
- type must be one of: "comment", "question", "suggestion"
- Focus on: bugs, security issues, performance, logic errors, edge cases, error handling, naming conventions, missing null checks, accessibility (for UI code), test coverage gaps
- Reference past team review patterns and LEARNING CONTEXT when provided — apply those lessons to THIS PR
- If TEAM DOCUMENTATION is provided, you MUST check the PR against those guidelines and produce at least one comment referencing a team doc guideline when the PR relates to the documented topic
- Be concise and actionable
- Skip trivial style/formatting issues
- Each comment must reference a specific file_path from the PR
- You MUST return at least 1 comment`;
}

function buildUserPrompt(
  prTitle: string,
  prDiff: string,
  changedFiles: string[],
  similarReviews: any[],
  similarCode: any[],
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

  // Limit diff to 16000 chars — larger context model allows more
  parts.push(`\nDiff:\n${prDiff.substring(0, 16000)}`);

  parts.push('\nRespond with JSON: {"summary": "...", "comments": [{"file_path": "...", "line_hint": "...", "comment": "...", "type": "comment|question|suggestion"}]}');

  return parts.join('\n');
}

function parseReviewResponse(content: string): any {
  // Try direct JSON parse
  try {
    return JSON.parse(content);
  } catch {
    // Try extracting from markdown fences
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[1].trim()); } catch { /* fall through */ }
    }
    // Try finding JSON object
    const braceMatch = content.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try { return JSON.parse(braceMatch[0]); } catch { /* fall through */ }
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

async function analyzePR(prUrl: string, channelId: string, messageTs: string): Promise<void> {
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
  const changedFiles = prFiles.map((f: any) => f.filename);

  log(`  PR "${prTitle}" by ${prAuthor}: ${changedFiles.length} files changed`);

  // 2. Generate embedding for the PR diff
  log('  Generating embedding for PR diff...');
  const fileList = changedFiles.slice(0, 15).join(', ') + (changedFiles.length > 15 ? ` (+${changedFiles.length - 15} more)` : '');
  const diffSummary = `PR: ${prTitle}\nAuthor: ${prAuthor}\nFiles: ${fileList}\n\n${prDiff.substring(0, 1500)}`;
  const diffEmbedding = await generateEmbedding(diffSummary);

  // 3. Search for similar past reviews and codebase context
  log('  Searching for similar past reviews...');
  let similarReviews: any[] = [];
  try {
    similarReviews = await fetchSimilarReviews(diffEmbedding, 10);
    log(`  Found ${similarReviews.length} similar past reviews`);
  } catch (error: any) {
    log(`  No similar reviews found: ${error.message}`);
  }

  log('  Searching for related codebase context...');
  let similarCode: any[] = [];
  try {
    similarCode = await fetchSimilarCode(diffEmbedding, 5);
    log(`  Found ${similarCode.length} related code chunks`);
  } catch (error: any) {
    log(`  No related code found: ${error.message}`);
  }

  // 3b. Fetch relevant team docs
  log('  Searching for relevant team docs...');
  const similarDocs = await fetchSimilarDocs(diffEmbedding, 3);
  log(`  Found ${similarDocs.length} relevant doc chunk(s)`);

  // 3c. Fetch learning context (lessons + feedback from similar past reviews)
  log('  Fetching relevant learning context...');
  const learningContext = await fetchLearningContext(diffEmbedding);
  log(`  Got ${learningContext.lessons.length} relevant lesson(s), ${learningContext.feedback.length} feedback item(s)`);

  // 4. Generate review via LLM
  log('  Generating AI review via Ollama...');
  const client = getOllama();
  const systemPrompt = buildSystemPrompt();
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
    review = parseReviewResponse(response.message.content.trim());
    log(`  Generated ${review.comments?.length || 0} review comments`);
  } catch (error: any) {
    logError(`  LLM generation failed: ${error.message}`);
    review = { comments: [], summary: `AI review failed: ${error.message}` };
  }

  // 5. Get suggested reviewers
  log('  Finding suggested reviewers...');
  let reviewers: any[] = [];
  try {
    reviewers = await fetchSuggestedReviewers(changedFiles, prAuthor, similarReviews);
    log(`  Found ${reviewers.length} suggested reviewers`);
  } catch (error: any) {
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
  } catch (error: any) {
    logError(`  Failed to report results: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Polling mode: check for PRs needing analysis
// ---------------------------------------------------------------------------

async function fetchPRsNeedingAnalysis(): Promise<any[]> {
  const response = await axios.get(`${HEROKU_API_URL}/api/prs-needing-analysis`, {
    headers: { 'X-Worker-API-Key': WORKER_API_KEY },
    timeout: 30000,
  });
  return response.data.prs || [];
}

async function runAnalysisLoop(): Promise<void> {
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
    } catch (error: any) {
      logError(`Failed to analyze ${pr.pr_url}: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
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
  } catch (error: any) {
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
