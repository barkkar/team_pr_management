/**
 * Embedding Service
 *
 * Uses Ollama to generate text embeddings for RAG.
 * Runs locally alongside the VPN worker.
 */

import { Ollama } from 'ollama';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

let ollamaClient: Ollama | null = null;

function getClient(): Ollama {
  if (!ollamaClient) {
    ollamaClient = new Ollama({ host: OLLAMA_HOST });
  }
  return ollamaClient;
}

/**
 * Generate an embedding vector for a single text input.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const client = getClient();
  const response = await client.embed({
    model: OLLAMA_EMBED_MODEL,
    input: text,
  });
  // Ollama returns embeddings as an array of arrays; take the first one
  return response.embeddings[0];
}

/**
 * Generate embeddings for multiple texts in batch.
 * Processes sequentially to avoid overwhelming the local Ollama server.
 */
export async function generateBatchEmbeddings(texts: string[]): Promise<number[][]> {
  const client = getClient();
  const results: number[][] = [];

  // Ollama embed supports batch input
  const BATCH_SIZE = 10;
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await client.embed({
      model: OLLAMA_EMBED_MODEL,
      input: batch,
    });
    results.push(...response.embeddings);
  }

  return results;
}

/**
 * Truncate text to fit within embedding model context window.
 * Most embedding models handle ~8192 tokens; we approximate at ~4 chars/token.
 */
export function truncateForEmbedding(text: string, maxChars: number = 2000): string {
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars);
}

/**
 * Create a rich text representation for a PR review comment suitable for embedding.
 */
export function formatReviewForEmbedding(review: {
  file_path: string | null;
  comment_body: string;
  review_state: string;
  diff_hunk: string | null;
  org: string;
  repo: string;
}): string {
  const parts: string[] = [];
  parts.push(`Repository: ${review.org}/${review.repo}`);
  if (review.file_path) parts.push(`File: ${review.file_path}`);
  parts.push(`Review type: ${review.review_state}`);
  if (review.diff_hunk) parts.push(`Code context:\n${review.diff_hunk}`);
  parts.push(`Comment:\n${review.comment_body}`);
  return truncateForEmbedding(parts.join('\n'));
}

/**
 * Check if Ollama is available and the embedding model is ready.
 */
export async function checkOllamaHealth(): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = getClient();
    // Try a simple embedding to verify model is loaded
    await client.embed({
      model: OLLAMA_EMBED_MODEL,
      input: 'health check',
    });
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}
