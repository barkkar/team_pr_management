"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubEnterpriseClient = void 0;
const axios_1 = __importDefault(require("axios"));
const gheTokenResolver_1 = require("../utils/gheTokenResolver");
class GitHubEnterpriseClient {
    constructor() {
        this.clientCache = new Map();
    }
    /**
     * Get or create an axios client for a specific hostname.
     * Resolves the correct token per hostname via GHE_TOKENS / GHE_TOKEN.
     */
    getClient(hostname) {
        if (!this.clientCache.has(hostname)) {
            const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
            const baseURL = `https://${hostname}/api/v3`;
            console.log(`Creating GitHub API client for: ${baseURL}`);
            this.clientCache.set(hostname, axios_1.default.create({
                baseURL,
                headers: {
                    Authorization: `token ${token}`,
                    Accept: 'application/vnd.github.v3+json',
                },
                timeout: 10000,
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
     * Check if a PR has received any reviews from someone other than the author.
     * Excludes PENDING reviews and the PR author's own reviews/comments.
     */
    async hasReviews(hostname, org, repo, prNumber, prAuthor) {
        const reviews = await this.getReviews(hostname, org, repo, prNumber);
        const externalReviews = reviews.filter(r => r.state !== 'PENDING' && (!prAuthor || r.user.login !== prAuthor));
        return externalReviews.length > 0;
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