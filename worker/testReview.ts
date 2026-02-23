#!/usr/bin/env npx ts-node
/**
 * Test Review (dry-run)
 *
 * Runs the full AI review pipeline for a given PR URL and logs results
 * to the console. Nothing is saved to the database or posted to Slack.
 *
 * Usage:
 *   npm run test-review -- https://git.soma.salesforce.com/org/repo/pull/123
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
  console.log(`[TestReview] ${message}`);
}

function logError(message: string): void {
  console.error(`[TestReview] ERROR: ${message}`);
}

function herokuHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Worker-API-Key': WORKER_API_KEY!,
  };
}

function extractHostname(prUrl: string): string | null {
  const match = prUrl.match(/https:\/\/([a-zA-Z0-9.-]+)/);
  return match ? match[1] : null;
}

function separator(title: string): void {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

// ---------------------------------------------------------------------------
// Ollama
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
// GHE API
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
// Heroku API (read-only queries)
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

async function fetchSuggestedReviewers(filePaths: string[], prAuthor: string, similarReviews?: any[]): Promise<any[]> {
  const response = await axios.post(
    `${HEROKU_API_URL}/api/suggested-reviewers`,
    { file_paths: filePaths, pr_author: prAuthor, similar_reviews: similarReviews || [] },
    { headers: herokuHeaders(), timeout: 30000 },
  );
  return response.data.reviewers || [];
}

// ---------------------------------------------------------------------------
// LLM Prompts
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
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

function buildUserPrompt(
  prTitle: string,
  prDiff: string,
  changedFiles: string[],
  similarReviews: any[],
  similarCode: any[],
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

  // Limit diff to 8000 chars to leave room for LLM response
  parts.push(`\nDiff:\n${prDiff.substring(0, 8000)}`);

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
    return {
      comments: [{ file_path: null, line_hint: null, comment: content.substring(0, 2000), type: 'comment' }],
      summary: 'AI review generated',
    };
  }
}

// ---------------------------------------------------------------------------
// Slack message formatter (mirrors formatSlackAnalysis in src/index.ts)
// ---------------------------------------------------------------------------

function formatSlackMessage(review: any, reviewers: any[]): { text: string; blocks: any[] } {
  const blocks: any[] = [];

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: ':robot_face: *AI Review Intelligence*' },
  });

  const comments = review?.comments || [];
  if (comments.length > 0) {
    const commentsByType: Record<string, any[]> = { comment: [], question: [], suggestion: [] };
    for (const c of comments) {
      const t = c.type || 'comment';
      if (!commentsByType[t]) commentsByType[t] = [];
      commentsByType[t].push(c);
    }

    if (commentsByType.comment.length > 0) {
      const lines = commentsByType.comment.map((c: any) => {
        const prefix = c.file_path ? `\`${c.file_path}\`` : '';
        const hint = c.line_hint ? ` (${c.line_hint})` : '';
        return `• ${prefix}${hint} ${c.comment}`;
      }).join('\n');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:memo: *Review Comments:*\n${lines}` } });
    }

    if (commentsByType.question.length > 0) {
      const lines = commentsByType.question.map((c: any) => {
        const prefix = c.file_path ? `\`${c.file_path}\`` : '';
        return `• ${prefix} ${c.comment}`;
      }).join('\n');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:question: *Questions:*\n${lines}` } });
    }

    if (commentsByType.suggestion.length > 0) {
      const lines = commentsByType.suggestion.map((c: any) => {
        const prefix = c.file_path ? `\`${c.file_path}\`` : '';
        return `• ${prefix} ${c.comment}`;
      }).join('\n');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:bulb: *Suggestions:*\n${lines}` } });
    }
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No specific review comments generated._' } });
  }

  if (review?.summary) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*Summary:* ${review.summary}` }] });
  }

  blocks.push({ type: 'divider' });

  if (reviewers && reviewers.length > 0) {
    const reviewerLines = reviewers.map((r: any, i: number) => {
      const mention = r.slack_user_id ? `<@${r.slack_user_id}>` : `\`${r.ghe_login}\``;
      const name = r.display_name ? ` (${r.display_name})` : '';
      return `${i + 1}. ${mention}${name} — ${r.reason}`;
    }).join('\n');
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:busts_in_silhouette: *Suggested Reviewers:*\n${reviewerLines}` } });
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: ':busts_in_silhouette: *Suggested Reviewers:*\n_No reviewer suggestions available yet._' } });
  }

  const text = `:robot_face: AI Review Intelligence — ${comments.length} comment(s), ${reviewers?.length || 0} reviewer suggestion(s)`;
  return { text, blocks };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
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
  } catch (error: any) {
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
  const changedFiles = prFiles.map((f: any) => f.filename);
  console.log(`  Files:    ${changedFiles.length} changed`);
  for (const f of changedFiles) {
    const file = prFiles.find((pf: any) => pf.filename === f);
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
  let similarReviews: any[] = [];
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
  } catch (error: any) {
    console.log(`  No similar reviews found: ${error.message}`);
  }

  separator('4. RELATED CODEBASE CONTEXT');
  let similarCode: any[] = [];
  try {
    similarCode = await fetchSimilarCode(diffEmbedding, 5);
    console.log(`  Found ${similarCode.length} related code chunks:\n`);
    for (let i = 0; i < similarCode.length; i++) {
      const c = similarCode[i];
      console.log(`  [${i + 1}] ${c.file_path}`);
      console.log(`      ${(c.content_chunk || '').substring(0, 150).replace(/\n/g, '\n      ')}`);
      console.log('');
    }
  } catch (error: any) {
    console.log(`  No related code found: ${error.message}`);
  }

  // 4. LLM review
  separator('5. AI REVIEW (via Ollama)');
  log(`Generating review with ${OLLAMA_MODEL}... (this may take a minute)`);
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(prTitle, prDiff, changedFiles, similarReviews, similarCode);

  let review: any;
  try {
    const client = getOllama();
    const response = await client.chat({
      model: OLLAMA_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      format: 'json',
      options: { temperature: 0.3, num_predict: 8192 },
    });

    const rawResponse = response.message.content.trim();
    console.log(`\n  Raw LLM response (first 500 chars):\n  ${rawResponse.substring(0, 500)}\n`);
    review = parseReviewResponse(rawResponse);

    // Handle empty or malformed responses
    if (!review.comments || review.comments.length === 0) {
      console.log('  ⚠️  LLM returned no comments. Raw response may not match expected schema.');
      console.log(`  Full raw response:\n  ${rawResponse}\n`);
    }

    console.log(`  Summary: ${review.summary || 'N/A'}\n`);
    const comments = review.comments || [];
    console.log(`  ${comments.length} review comment(s):\n`);
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      console.log(`  --- Comment ${i + 1} [${c.type || 'comment'}] ---`);
      if (c.file_path) console.log(`  File: ${c.file_path}`);
      if (c.line_hint) console.log(`  Location: ${c.line_hint}`);
      console.log(`  ${c.comment}`);
      console.log('');
    }
  } catch (error: any) {
    logError(`LLM generation failed: ${error.message}`);
    review = { comments: [], summary: `Failed: ${error.message}` };
  }

  // 5. Suggested reviewers
  separator('6. SUGGESTED REVIEWERS');
  let reviewers: any[] = [];
  try {
    reviewers = await fetchSuggestedReviewers(changedFiles, prAuthor, similarReviews);
    if (reviewers.length === 0) {
      console.log('  No reviewer suggestions (not enough review history yet)');
    } else {
      for (let i = 0; i < reviewers.length; i++) {
        const r = reviewers[i];
        console.log(`  [${i + 1}] ${r.ghe_login}${r.slack_user_id ? ` (Slack: <@${r.slack_user_id}>)` : ''}`);
        console.log(`      Score: ${r.score}  Reason: ${r.reason || 'N/A'}`);
      }
    }
  } catch (error: any) {
    console.log(`  Could not fetch reviewer suggestions: ${error.message}`);
  }

  // 6. Slack message preview
  separator('7. SLACK MESSAGE PREVIEW');
  const slackMessage = formatSlackMessage(review, reviewers);
  console.log('  Below is what would be posted as a Slack thread reply:\n');
  console.log('  ┌─────────────────────────────────────────────────────────┐');
  for (const block of slackMessage.blocks) {
    if (block.type === 'divider') {
      console.log('  │ ─────────────────────────────────────────────────────── │');
    } else if (block.type === 'section' && block.text?.text) {
      const lines = block.text.text.split('\n');
      for (const line of lines) {
        console.log(`  │ ${line}`);
      }
    } else if (block.type === 'context' && block.elements) {
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
    separator('8. POSTING TO SLACK');
    const slackToken = process.env.SLACK_BOT_TOKEN;
    if (!slackToken) {
      logError('SLACK_BOT_TOKEN is required to post. Skipping Slack post.');
    } else if (!postChannel) {
      logError('Provide --channel=CHANNEL_ID to post. Example: --post --channel=C0123456');
    } else {
      log(`Posting to channel ${postChannel}...`);
      try {
        const postResp = await axios.post('https://slack.com/api/chat.postMessage', {
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
        } else {
          logError(`Slack API error: ${postResp.data.error}`);
        }
      } catch (error: any) {
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
