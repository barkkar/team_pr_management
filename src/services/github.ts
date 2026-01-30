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
  private client: AxiosInstance;
  
  constructor() {
    const baseURL = process.env.GHE_BASE_URL || 'https://git.soma.salesforce.com/api/v3';
    const token = process.env.GHE_TOKEN;
    
    if (!token) {
      throw new Error('GHE_TOKEN environment variable is required');
    }
    
    this.client = axios.create({
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
  async getReviews(org: string, repo: string, prNumber: number): Promise<Review[]> {
    try {
      const response = await this.client.get<Review[]>(
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
  async hasReviews(org: string, repo: string, prNumber: number): Promise<boolean> {
    const reviews = await this.getReviews(org, repo, prNumber);
    
    // Filter out pending reviews - only count submitted reviews
    const submittedReviews = reviews.filter(r => r.state !== 'PENDING');
    
    return submittedReviews.length > 0;
  }
  
  /**
   * Get PR details to check if it's still open
   */
  async getPRDetails(org: string, repo: string, prNumber: number): Promise<PRDetails> {
    try {
      const response = await this.client.get<PRDetails>(
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
  async isPROpen(org: string, repo: string, prNumber: number): Promise<boolean> {
    const details = await this.getPRDetails(org, repo, prNumber);
    return details.state === 'open' && !details.merged;
  }
}
