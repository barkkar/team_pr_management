"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubEnterpriseClient = void 0;
const axios_1 = __importDefault(require("axios"));
class GitHubEnterpriseClient {
    constructor() {
        const baseURL = process.env.GHE_BASE_URL || 'https://git.soma.salesforce.com/api/v3';
        const token = process.env.GHE_TOKEN;
        if (!token) {
            throw new Error('GHE_TOKEN environment variable is required');
        }
        this.client = axios_1.default.create({
            baseURL,
            headers: {
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github.v3+json',
            },
        });
    }
    /**
     * Get reviews for a pull request
     */
    async getReviews(org, repo, prNumber) {
        try {
            const response = await this.client.get(`/repos/${org}/${repo}/pulls/${prNumber}/reviews`);
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
    async hasReviews(org, repo, prNumber) {
        const reviews = await this.getReviews(org, repo, prNumber);
        // Filter out pending reviews - only count submitted reviews
        const submittedReviews = reviews.filter(r => r.state !== 'PENDING');
        return submittedReviews.length > 0;
    }
    /**
     * Get PR details to check if it's still open
     */
    async getPRDetails(org, repo, prNumber) {
        try {
            const response = await this.client.get(`/repos/${org}/${repo}/pulls/${prNumber}`);
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
    async isPROpen(org, repo, prNumber) {
        const details = await this.getPRDetails(org, repo, prNumber);
        return details.state === 'open' && !details.merged;
    }
}
exports.GitHubEnterpriseClient = GitHubEnterpriseClient;
//# sourceMappingURL=github.js.map