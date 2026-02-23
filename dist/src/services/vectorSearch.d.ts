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
 * Combines three signals:
 *   1. People who reviewed similar files before (directory-level fuzzy match)
 *   2. People who authored changes to similar files
 *   3. People who appear in semantically similar past reviews (vector search)
 */
export declare function findSuggestedReviewers(filePaths: string[], excludeAuthor?: string, topK?: number, similarReviews?: {
    reviewer_login?: string;
    similarity?: number;
}[]): Promise<ReviewerCandidate[]>;
//# sourceMappingURL=vectorSearch.d.ts.map