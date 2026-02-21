/**
 * Embedding Service
 *
 * Uses Ollama to generate text embeddings for RAG.
 * Runs locally alongside the VPN worker.
 */
/**
 * Generate an embedding vector for a single text input.
 */
export declare function generateEmbedding(text: string): Promise<number[]>;
/**
 * Generate embeddings for multiple texts in batch.
 * Processes sequentially to avoid overwhelming the local Ollama server.
 */
export declare function generateBatchEmbeddings(texts: string[]): Promise<number[][]>;
/**
 * Truncate text to fit within embedding model context window.
 * Most embedding models handle ~8192 tokens; we approximate at ~4 chars/token.
 */
export declare function truncateForEmbedding(text: string, maxChars?: number): string;
/**
 * Create a rich text representation for a PR review comment suitable for embedding.
 */
export declare function formatReviewForEmbedding(review: {
    file_path: string | null;
    comment_body: string;
    review_state: string;
    diff_hunk: string | null;
    org: string;
    repo: string;
}): string;
/**
 * Check if Ollama is available and the embedding model is ready.
 */
export declare function checkOllamaHealth(): Promise<{
    ok: boolean;
    error?: string;
}>;
//# sourceMappingURL=embeddingService.d.ts.map