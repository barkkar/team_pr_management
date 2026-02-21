/**
 * Reviewer Suggester
 *
 * Identifies the best reviewers for a PR based on:
 * - Past review history on similar files
 * - Code authorship history
 * - GHE → Slack user mapping for @mentions
 */
export interface SuggestedReviewer {
    ghe_login: string;
    slack_user_id: string | null;
    display_name: string | null;
    score: number;
    reason: string;
    files: string[];
}
/**
 * Get suggested reviewers for a PR, resolved with Slack user IDs where possible.
 */
export declare function getSuggestedReviewers(changedFiles: string[], prAuthor?: string, topK?: number): Promise<SuggestedReviewer[]>;
/**
 * Format reviewer suggestions for Slack display.
 * Uses @mention for users with Slack IDs, falls back to GHE login.
 */
export declare function formatReviewerSuggestions(reviewers: SuggestedReviewer[]): string;
//# sourceMappingURL=reviewerSuggester.d.ts.map