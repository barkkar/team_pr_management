import axios, { AxiosInstance } from 'axios';

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
  private token: string;
  private clientCache: Map<string, AxiosInstance> = new Map();
  
  constructor() {
    const token = process.env.GHE_TOKEN;
    
    if (!token) {
      throw new Error('GHE_TOKEN environment variable is required');
    }
    
    this.token = token;
  }
  
  /**
   * Get or create an axios client for a specific hostname
   */
  private getClient(hostname: string): AxiosInstance {
    if (!this.clientCache.has(hostname)) {
      const baseURL = `https://${hostname}/api/v3`;
      console.log(`Creating GitHub API client for: ${baseURL}`);
      
      this.clientCache.set(hostname, axios.create({
        baseURL,
        headers: {
          Authorization: `token ${this.token}`,
          Accept: 'application/vnd.github.v3+json',
        },
        timeout: 10000, // 10 second timeout
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
   * Check if a PR has received any reviews
   * Excludes PENDING reviews (drafts that haven't been submitted)
   */
  async hasReviews(hostname: string, org: string, repo: string, prNumber: number): Promise<boolean> {
    const reviews = await this.getReviews(hostname, org, repo, prNumber);
    
    // Filter out pending reviews - only count submitted reviews
    const submittedReviews = reviews.filter(r => r.state !== 'PENDING');
    
    return submittedReviews.length > 0;
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
