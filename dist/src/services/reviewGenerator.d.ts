/**
 * LLM Review Generator
 *
 * Uses Claude AI to generate AI-powered code review comments based on:
 * - PR diff content
 * - Similar past review comments (RAG)
 * - Codebase knowledge (RAG)
 */
import { SimilarReview, SimilarCode } from './vectorSearch';
export interface ReviewComment {
    file_path: string | null;
    line_hint: string | null;
    comment: string;
    type: 'comment' | 'question' | 'suggestion';
}
export interface GeneratedReview {
    comments: ReviewComment[];
    summary: string;
}
/**
 * Generate review comments for a PR using Claude AI.
 */
export declare function generateReview(prTitle: string, prDiff: string, changedFiles: string[], similarReviews: SimilarReview[], similarCode: SimilarCode[]): Promise<GeneratedReview>;
/**
 * Check if Claude AI is available.
 */
export declare function checkLLMHealth(): Promise<{
    ok: boolean;
    error?: string;
}>;
//# sourceMappingURL=reviewGenerator.d.ts.map