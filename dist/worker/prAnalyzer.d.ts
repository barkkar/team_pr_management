#!/usr/bin/env npx ts-node
/**
 * PR Analyzer — Reviewer Suggestions (tool-use)
 *
 * For a newly tracked PR this worker invokes Claude with four tools and lets
 * Claude decide what PR context to fetch. The worker executes the tools
 * against GHE and Postgres; Claude returns a ranked reviewer list as JSON.
 *
 * Tools:
 *   - fetch_pr_files(pr_url): returns list of changed file paths
 *   - fetch_pr_diff(pr_url, max_bytes?): returns unified diff text (truncated)
 *   - get_channel_members(channel_id): resolved channel members with GHE logins
 *   - get_file_history(pr_url, file_path, limit?): recent commits touching a file
 *   - get_pr_reviewers(pr_url, pr_number): reviewers of a specific PR
 *
 * Usage:
 *   npm run suggest-reviewers -- https://gitcore.soma.salesforce.com/org/repo/pull/42
 *   (or the polling loop picks PRs from /api/prs-needing-reviewer-suggestions)
 */
import 'dotenv/config';
export declare function fetchFileCommits(host: string, org: string, repo: string, filePath: string, limit?: number): Promise<Array<{
    sha: string;
    author_login: string | null;
    date: string;
    message: string;
}>>;
export declare function fetchPrReviews(host: string, org: string, repo: string, prNumber: number): Promise<Array<{
    user_login: string;
    state: string;
    submitted_at: string;
}>>;
/**
 * One-shot polling pass: fetch PRs needing reviewer suggestions from Heroku,
 * run the tool-loop for each. Safe to call from other workers — errors on a
 * single PR are logged and swallowed so the caller isn't disrupted.
 */
export declare function runSuggestReviewersLoop(): Promise<void>;
//# sourceMappingURL=prAnalyzer.d.ts.map