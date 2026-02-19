import axios, { AxiosInstance } from 'axios';
import { requireTokenForHost } from '../utils/gheTokenResolver';

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

export class GitHubEnterpriseClient {
  private clientCache: Map<string, AxiosInstance> = new Map();

  /**
   * Get or create an axios client for a specific hostname.
   * Resolves the correct token per hostname via GHE_TOKENS / GHE_TOKEN.
   */
  private getClient(hostname: string): AxiosInstance {
    if (!this.clientCache.has(hostname)) {
      const token = requireTokenForHost(hostname);
      const baseURL = `https://${hostname}/api/v3`;
      console.log(`Creating GitHub API client for: ${baseURL}`);
      
      this.clientCache.set(hostname, axios.create({
        baseURL,
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
        timeout: 10000,
      }));
    }
    return this.clientCache.get(hostname)!;
  }
  
  /**
   * Get reviews for a pull request
   */
  async getReviews(hostname: string, org: string, repo: string, prNumber: number): Promise<Review[]> {
    try {
      const client = this.getClient(hostname);
      const response = await client.get<Review[]>(
        `/repos/${org}/${repo}/pulls/${prNumber}/reviews`
      );
      return response.data;
    } catch (error) {
      console.error(`Failed to get reviews for ${org}/${repo}#${prNumber}:`, error);
      throw error;
    }
  }
  
  /**
   * Check if a PR has received any reviews from someone other than the author.
   * Excludes PENDING reviews and the PR author's own reviews/comments.
   */
  async hasReviews(hostname: string, org: string, repo: string, prNumber: number, prAuthor?: string): Promise<boolean> {
    const reviews = await this.getReviews(hostname, org, repo, prNumber);

    const externalReviews = reviews.filter(
      r => r.state !== 'PENDING' && (!prAuthor || r.user.login !== prAuthor),
    );

    return externalReviews.length > 0;
  }
  
  /**
   * Get PR details to check if it's still open
   */
  async getPRDetails(hostname: string, org: string, repo: string, prNumber: number): Promise<PRDetails> {
    try {
      const client = this.getClient(hostname);
      const response = await client.get<PRDetails>(
        `/repos/${org}/${repo}/pulls/${prNumber}`
      );
      return response.data;
    } catch (error) {
      console.error(`Failed to get PR details for ${org}/${repo}#${prNumber}:`, error);
      throw error;
    }
  }
  
  /**
   * Check if a PR is still open (not merged or closed)
   */
  async isPROpen(hostname: string, org: string, repo: string, prNumber: number): Promise<boolean> {
    const details = await this.getPRDetails(hostname, org, repo, prNumber);
    return details.state === 'open' && !details.merged;
  }
}
