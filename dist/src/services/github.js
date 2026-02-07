"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubEnterpriseClient = void 0;
const axios_1 = __importDefault(require("axios"));
class GitHubEnterpriseClient {
    constructor() {
        this.clientCache = new Map();
        const token = process.env.GHE_TOKEN;
        if (!token) {
            throw new Error('GHE_TOKEN environment variable is required');
        }
        this.token = token;
    }
    /**
     * Get or create an axios client for a specific hostname
     */
    getClient(hostname) {
        if (!this.clientCache.has(hostname)) {
            const baseURL = `https://${hostname}/api/v3`;
            console.log(`Creating GitHub API client for: ${baseURL}`);
            this.clientCache.set(hostname, axios_1.default.create({
                baseURL,
                headers: {
                    Authorization: `token ${this.token}`,
                    Accept: 'application/vnd.github.v3+json',
                },
                timeout: 10000, // 10 second timeout
            }));
        }
        return this.clientCache.get(hostname);
    }
    /**
     * Get reviews for a pull request
     */
    async getReviews(hostname, org, repo, prNumber) {
        try {
            const client = this.getClient(hostname);
            const response = await client.get(`/repos/${org}/${repo}/pulls/${prNumber}/reviews`);
            return response.data;
        }
        catch (error) {
            console.error(`Failed to get reviews for ${org}/${repo}#${prNumber}:`, error);
            throw error;
        }
    }
    /**
     * Check if a PR has received any reviews
     * Excludes PENDING reviews (drafts that haven't been submitted)
     */
    async hasReviews(hostname, org, repo, prNumber) {
        const reviews = await this.getReviews(hostname, org, repo, prNumber);
        // Filter out pending reviews - only count submitted reviews
        const submittedReviews = reviews.filter(r => r.state !== 'PENDING');
        return submittedReviews.length > 0;
    }
    /**
     * Get PR details to check if it's still open
     */
    async getPRDetails(hostname, org, repo, prNumber) {
        try {
            const client = this.getClient(hostname);
            const response = await client.get(`/repos/${org}/${repo}/pulls/${prNumber}`);
            return response.data;
        }
        catch (error) {
            console.error(`Failed to get PR details for ${org}/${repo}#${prNumber}:`, error);
            throw error;
        }
    }
    /**
     * Check if a PR is still open (not merged or closed)
     */
    async isPROpen(hostname, org, repo, prNumber) {
        const details = await this.getPRDetails(hostname, org, repo, prNumber);
        return details.state === 'open' && !details.merged;
    }
}
exports.GitHubEnterpriseClient = GitHubEnterpriseClient;
//# sourceMappingURL=github.js.map