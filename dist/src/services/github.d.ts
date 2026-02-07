interface Review {
    id: number;
    user: {
        login: string;
    };
    state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
    submitted_at: string;
}
interface PRDetails {
    state: 'open' | 'closed';
    merged: boolean;
    title: string;
    user: {
        login: string;
    };
}
export declare class GitHubEnterpriseClient {
    private token;
    private clientCache;
    constructor();
    /**
     * Get or create an axios client for a specific hostname
     */
    private getClient;
    /**
     * Get reviews for a pull request
     */
    getReviews(hostname: string, org: string, repo: string, prNumber: number): Promise<Review[]>;
    /**
     * Check if a PR has received any reviews
     * Excludes PENDING reviews (drafts that haven't been submitted)
     */
    hasReviews(hostname: string, org: string, repo: string, prNumber: number): Promise<boolean>;
    /**
     * Get PR details to check if it's still open
     */
    getPRDetails(hostname: string, org: string, repo: string, prNumber: number): Promise<PRDetails>;
    /**
     * Check if a PR is still open (not merged or closed)
     */
    isPROpen(hostname: string, org: string, repo: string, prNumber: number): Promise<boolean>;
}
export {};
//# sourceMappingURL=github.d.ts.map