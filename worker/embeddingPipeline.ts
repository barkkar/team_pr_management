#!/usr/bin/env npx ts-node
/**
 * Embedding Pipeline
 *
 * Processes un-embedded records from pr_reviews and repo_knowledge,
 * generates embeddings via local Ollama, and stores them via Heroku API.
 *
 * Usage:
 *   npm run embed
 */

import 'dotenv/config';
import axios from 'axios';
import { Ollama } from 'ollama';

const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [EmbeddingPipeline] ${message}`);
}

function logError(message: string): void {
  console.error(`[${new Date().toISOString()}] [EmbeddingPipeline] ${message}`);
}

function herokuHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Worker-API-Key': WORKER_API_KEY!,
  };
}

function truncateForEmbedding(text: string, maxChars: number = 8000): string {
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars);
}

// ---------------------------------------------------------------------------
// Ollama embedding
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
  const response = await client.embed({
    model: OLLAMA_EMBED_MODEL,
    input: truncateForEmbedding(text),
  });
  return response.embeddings[0];
}

// ---------------------------------------------------------------------------
// Heroku API helpers
// ---------------------------------------------------------------------------

async function fetchUnembeddedReviews(limit: number = 50): Promise<any[]> {
  const response = await axios.get(`${HEROKU_API_URL}/api/unembedded-reviews`, {
    params: { limit },
    headers: { 'X-Worker-API-Key': WORKER_API_KEY },
    timeout: 30000,
  });
  return response.data.reviews || [];
}

async function fetchUnembeddedRepoKnowledge(limit: number = 50): Promise<any[]> {
  const response = await axios.get(`${HEROKU_API_URL}/api/unembedded-repo-knowledge`, {
    params: { limit },
    headers: { 'X-Worker-API-Key': WORKER_API_KEY },
    timeout: 30000,
  });
  return response.data.chunks || [];
}

async function reportEmbeddings(embeddings: {
  content_type: string;
  source_id: number;
  content_text: string;
  embedding: number[];
  metadata: Record<string, any>;
}[]): Promise<void> {
  await axios.post(`${HEROKU_API_URL}/api/embeddings`, { embeddings }, {
    headers: herokuHeaders(),
    timeout: 60000,
  });
}

async function reportRepoKnowledgeEmbeddings(updates: {
  id: number;
  embedding: number[];
}[]): Promise<void> {
  await axios.post(`${HEROKU_API_URL}/api/repo-knowledge-embeddings`, { updates }, {
    headers: herokuHeaders(),
    timeout: 60000,
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatReviewForEmbedding(review: any): string {
  const parts: string[] = [];
  parts.push(`Repository: ${review.org}/${review.repo}`);
  if (review.file_path) parts.push(`File: ${review.file_path}`);
  parts.push(`Review type: ${review.review_state}`);
  if (review.diff_hunk) parts.push(`Code context:\n${review.diff_hunk}`);
  parts.push(`Comment:\n${review.comment_body}`);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function embedReviews(): Promise<number> {
  log('Processing un-embedded PR reviews...');
  let totalEmbedded = 0;
  const failedReviewIds = new Set<number>();

  while (true) {
    const reviews = await fetchUnembeddedReviews(50);
    const pending = reviews.filter((r) => !failedReviewIds.has(r.id));
    if (pending.length === 0) break;

    log(`  Found ${pending.length} un-embedded reviews`);

    const batch: any[] = [];
    for (const review of pending) {
      try {
        const text = formatReviewForEmbedding(review);
        const embedding = await generateEmbedding(text);

        batch.push({
          content_type: 'pr_review',
          source_id: review.id,
          content_text: truncateForEmbedding(text, 5000),
          embedding,
          metadata: {
            org: review.org,
            repo: review.repo,
            pr_number: review.pr_number,
            file_path: review.file_path,
            reviewer: review.reviewer_login,
          },
        });
      } catch (error: any) {
        logError(`  Failed to embed review ${review.id}: ${error.message}`);
        failedReviewIds.add(review.id);
      }
    }

    if (batch.length > 0) {
      try {
        await reportEmbeddings(batch);
        totalEmbedded += batch.length;
        log(`  Embedded and reported ${batch.length} reviews`);
      } catch (error: any) {
        logError(`  Failed to report embeddings: ${error.message}`);
      }
    }
  }

  if (failedReviewIds.size > 0) {
    logError(`  Skipped ${failedReviewIds.size} reviews that failed to embed: ${[...failedReviewIds].join(', ')}`);
  }

  return totalEmbedded;
}

async function embedRepoKnowledge(): Promise<number> {
  log('Processing un-embedded repo knowledge chunks...');
  let totalEmbedded = 0;
  const failedChunkIds = new Set<number>();

  while (true) {
    const chunks = await fetchUnembeddedRepoKnowledge(50);
    const pending = chunks.filter((c) => !failedChunkIds.has(c.id));
    if (pending.length === 0) break;

    log(`  Found ${pending.length} un-embedded chunks`);

    const batch: { id: number; embedding: number[] }[] = [];
    for (const chunk of pending) {
      try {
        const embedding = await generateEmbedding(chunk.content_chunk);
        batch.push({ id: chunk.id, embedding });
      } catch (error: any) {
        logError(`  Failed to embed chunk ${chunk.id}: ${error.message}`);
        failedChunkIds.add(chunk.id);
      }
    }

    if (batch.length > 0) {
      try {
        await reportRepoKnowledgeEmbeddings(batch);
        totalEmbedded += batch.length;
        log(`  Embedded and reported ${batch.length} chunks`);
      } catch (error: any) {
        logError(`  Failed to report repo knowledge embeddings: ${error.message}`);
      }
    }
  }

  if (failedChunkIds.size > 0) {
    logError(`  Skipped ${failedChunkIds.size} chunks that failed to embed: ${[...failedChunkIds].join(', ')}`);
  }

  return totalEmbedded;
}

async function run(): Promise<void> {
  log('='.repeat(60));
  log('Embedding Pipeline starting...');
  log('='.repeat(60));

  if (!HEROKU_API_URL || !WORKER_API_KEY) {
    logError('HEROKU_API_URL and WORKER_API_KEY are required');
    process.exit(1);
  }

  // Verify Ollama is reachable
  try {
    const client = getOllama();
    await client.embed({ model: OLLAMA_EMBED_MODEL, input: 'health check' });
    log(`Ollama is reachable at ${OLLAMA_HOST} with model ${OLLAMA_EMBED_MODEL}`);
  } catch (error: any) {
    logError(`Ollama not reachable at ${OLLAMA_HOST}: ${error.message}`);
    logError('Make sure Ollama is running: ollama serve');
    logError(`Make sure model is pulled: ollama pull ${OLLAMA_EMBED_MODEL}`);
    process.exit(1);
  }

  const reviewCount = await embedReviews();
  const chunkCount = await embedRepoKnowledge();

  log(`Done! Embedded ${reviewCount} reviews, ${chunkCount} repo knowledge chunks.`);
}

run().then(() => process.exit(0)).catch((error) => {
  logError(`Fatal error: ${error}`);
  process.exit(1);
});
