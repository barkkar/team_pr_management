"use strict";
/**
 * Embedding Service
 *
 * Uses Ollama to generate text embeddings for RAG.
 * Runs locally alongside the VPN worker.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateEmbedding = generateEmbedding;
exports.generateBatchEmbeddings = generateBatchEmbeddings;
exports.truncateForEmbedding = truncateForEmbedding;
exports.formatReviewForEmbedding = formatReviewForEmbedding;
exports.checkOllamaHealth = checkOllamaHealth;
const ollama_1 = require("ollama");
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
let ollamaClient = null;
function getClient() {
    if (!ollamaClient) {
        ollamaClient = new ollama_1.Ollama({ host: OLLAMA_HOST });
    }
    return ollamaClient;
}
/**
 * Generate an embedding vector for a single text input.
 */
async function generateEmbedding(text) {
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
async function generateBatchEmbeddings(texts) {
    const client = getClient();
    const results = [];
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
function truncateForEmbedding(text, maxChars = 30000) {
    if (text.length <= maxChars)
        return text;
    return text.substring(0, maxChars);
}
/**
 * Create a rich text representation for a PR review comment suitable for embedding.
 */
function formatReviewForEmbedding(review) {
    const parts = [];
    parts.push(`Repository: ${review.org}/${review.repo}`);
    if (review.file_path)
        parts.push(`File: ${review.file_path}`);
    parts.push(`Review type: ${review.review_state}`);
    if (review.diff_hunk)
        parts.push(`Code context:\n${review.diff_hunk}`);
    parts.push(`Comment:\n${review.comment_body}`);
    return truncateForEmbedding(parts.join('\n'));
}
/**
 * Check if Ollama is available and the embedding model is ready.
 */
async function checkOllamaHealth() {
    try {
        const client = getClient();
        // Try a simple embedding to verify model is loaded
        await client.embed({
            model: OLLAMA_EMBED_MODEL,
            input: 'health check',
        });
        return { ok: true };
    }
    catch (error) {
        return { ok: false, error: error.message };
    }
}
//# sourceMappingURL=embeddingService.js.map