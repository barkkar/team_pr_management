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

async function fetchSuggestedReviewers(filePaths: string[], prAuthor: string): Promise<any[]> {
  const response = await axios.post(
    `${HEROKU_API_URL}/api/suggested-reviewers`,
    { file_paths: filePaths, pr_author: prAuthor },
    { headers: herokuHeaders(), timeout: 30000 },
  );
  return response.data.reviewers || [];
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

function buildUserPrompt(
  prTitle: string,
  prDiff: string,
  changedFiles: string[],
  similarReviews: any[],
  similarCode: any[],
): string {
  const parts: string[] = [];

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
  const diffSummary = `PR: ${prTitle}\nAuthor: ${prAuthor}\nFiles: ${changedFiles.join(', ')}\n\n${prDiff.substring(0, 4000)}`;
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

  // 4. Generate review via LLM
  log('  Generating AI review via Ollama...');
  const client = getOllama();
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(prTitle, prDiff, changedFiles, similarReviews, similarCode);

  let review: any;
  try {
    const response = await client.chat({
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      options: { temperature: 0.3, num_predict: 4096 },
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
    reviewers = await fetchSuggestedReviewers(changedFiles, prAuthor);
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
