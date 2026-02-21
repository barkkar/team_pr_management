/**
 * Vector Search Service
 *
 * Provides similarity search over PR review embeddings and codebase knowledge
 * using pgvector cosine distance.
 */
import { PRReview, RepoKnowledge } from '../db/client';
export interface SimilarReview extends PRReview {
    similarity: number;
}
export interface SimilarCode extends RepoKnowledge {
    similarity: number;
}
export interface ReviewerCandidate {
    ghe_login: string;
    score: number;
    reason: string;
    files: string[];
}
/**
 * Find past review comments similar to a given embedding.
 */
export declare function findSimilarReviews(embedding: number[], topK?: number, minSimilarity?: number): Promise<SimilarReview[]>;
/**
 * Find codebase knowledge chunks similar to a given embedding.
 */
export declare function findSimilarCodeChunks(embedding: number[], topK?: number, minSimilarity?: number): Promise<SimilarCode[]>;
/**
 * Find suggested reviewers based on file paths changed in a PR.
 * Combines two signals:
 *   1. People who reviewed similar files before
 *   2. People who authored changes to similar files
 */
export declare function findSuggestedReviewers(filePaths: string[], excludeAuthor?: string, topK?: number): Promise<ReviewerCandidate[]>;
//# sourceMappingURL=vectorSearch.d.ts.map