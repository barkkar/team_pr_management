import { Pool } from 'pg';
declare const pool: Pool;
export interface TrackedPR {
    id: number;
    pr_url: string;
    org: string;
    repo: string;
    pr_number: number;
    channel_id: string;
    message_ts: string;
    posted_at: Date;
    eligible_reminder_at: Date;
    reminder_sent: boolean;
    created_at: Date;
    has_reviews?: boolean;
    is_open?: boolean;
    status_checked_at?: Date;
    reminder_count?: number;
}
export interface PRStatusUpdate {
    pr_url: string;
    is_open: boolean;
    has_reviews: boolean;
}
export interface MonitoredChannel {
    id: number;
    channel_id: string;
    channel_name: string | null;
    added_by: string;
    added_at: Date;
    enabled: boolean;
}
export declare function insertTrackedPR(pr: Omit<TrackedPR, 'id' | 'reminder_sent' | 'created_at'>): Promise<TrackedPR | null>;
export declare function getPendingReminders(): Promise<TrackedPR[]>;
export declare function markReminderSent(id: number): Promise<void>;
/**
 * Schedule the next reminder (for recurring reminders).
 * Keeps reminder_sent = FALSE so the PR stays in the pending pool.
 * When nextAt is provided, uses that time (e.g. from getNextReminderEligibleTime for 9-5 PST).
 */
export declare function scheduleNextReminder(id: number, nextAt?: Date): Promise<void>;
/**
 * Get all open PRs that haven't received reviews yet (for /pr-monitor pending).
 * Unlike getPendingReminders(), this is not gated by eligible_reminder_at or reminder_sent.
 */
export declare function getOpenUnreviewedPRs(): Promise<TrackedPR[]>;
export declare function markPRClosed(id: number): Promise<void>;
export declare function getTrackedPRByUrl(prUrl: string): Promise<TrackedPR | null>;
/**
 * Get PRs that need status checking by the worker
 * Returns PRs that:
 * - Are open or unknown (not known to be closed)
 * - Haven't been checked in the last 5 minutes
 */
export declare function getPRsNeedingStatusCheck(): Promise<TrackedPR[]>;
/**
 * Update PR status from worker
 */
export declare function updatePRStatus(prUrl: string, isOpen: boolean, hasReviews: boolean): Promise<void>;
/**
 * Add a channel to monitoring
 */
export declare function addMonitoredChannel(channelId: string, channelName: string | null, addedBy: string): Promise<MonitoredChannel | null>;
/**
 * Remove a channel from monitoring (soft delete - sets enabled = false)
 */
export declare function removeMonitoredChannel(channelId: string): Promise<boolean>;
/**
 * Get all enabled monitored channels
 */
export declare function getMonitoredChannels(): Promise<MonitoredChannel[]>;
/**
 * Check if a channel is being monitored
 */
export declare function isChannelMonitored(channelId: string): Promise<boolean>;
export interface ReviewStats {
    totalTracked: number;
    reviewedWithoutReminders: number;
    reviewedAfterReminders: number;
    stillAwaiting: number;
    closed: number;
    reminderBreakdown: {
        reminders: string;
        count: number;
    }[];
    avgRemindersBeforeReview: number;
}
export declare function getReviewStats(): Promise<ReviewStats>;
export interface PRReview {
    id: number;
    pr_url: string;
    pr_number: number;
    org: string;
    repo: string;
    reviewer_login: string;
    file_path: string | null;
    diff_hunk: string | null;
    comment_body: string;
    review_state: string;
    submitted_at: Date | null;
    created_at: Date;
}
export interface PRFile {
    id: number;
    pr_url: string;
    pr_number: number;
    org: string;
    repo: string;
    file_path: string;
    change_type: string;
    additions: number;
    deletions: number;
    patch_snippet: string | null;
    author_login: string | null;
    created_at: Date;
}
export interface UserMapping {
    id: number;
    ghe_login: string;
    slack_user_id: string | null;
    display_name: string | null;
    email: string | null;
    discovered_via: string;
    updated_at: Date;
}
export interface HarvestState {
    id: number;
    org: string;
    repo: string;
    last_harvested_pr_number: number;
    last_repo_harvest_sha: string | null;
    last_harvested_at: Date | null;
    last_repo_harvested_at: Date | null;
}
export interface RepoKnowledge {
    id: number;
    org: string;
    repo: string;
    file_path: string;
    content_chunk: string;
    chunk_index: number;
    last_commit_sha: string | null;
    created_at: Date;
    updated_at: Date;
}
export interface EmbeddingRecord {
    id: number;
    content_type: string;
    source_id: number;
    content_text: string;
    metadata: Record<string, any>;
    created_at: Date;
}
export declare function insertPRReview(review: Omit<PRReview, 'id' | 'created_at'>): Promise<PRReview | null>;
export declare function getPRReviewCount(prUrl: string): Promise<number>;
export declare function insertPRFile(file: Omit<PRFile, 'id' | 'created_at'>): Promise<PRFile | null>;
export declare function upsertUserMapping(mapping: Omit<UserMapping, 'id' | 'updated_at'>): Promise<UserMapping | null>;
export declare function getUserMapping(gheLogin: string): Promise<UserMapping | null>;
export declare function getAllUserMappings(): Promise<UserMapping[]>;
export declare function getHarvestState(org: string, repo: string): Promise<HarvestState | null>;
export declare function upsertHarvestState(org: string, repo: string, lastPrNumber: number): Promise<void>;
export declare function upsertRepoHarvestState(org: string, repo: string, sha: string): Promise<void>;
export declare function upsertRepoKnowledge(chunk: Omit<RepoKnowledge, 'id' | 'created_at' | 'updated_at'>): Promise<number>;
export declare function deleteRepoKnowledgeForFile(org: string, repo: string, filePath: string): Promise<void>;
export declare function insertEmbedding(contentType: string, sourceId: number, contentText: string, embedding: number[], metadata?: Record<string, any>): Promise<number>;
export declare function updateRepoKnowledgeEmbedding(id: number, embedding: number[]): Promise<void>;
export declare function getUnembeddedPRReviews(limit?: number): Promise<PRReview[]>;
export declare function getUnembeddedRepoKnowledge(limit?: number): Promise<RepoKnowledge[]>;
export declare function searchSimilarReviews(embedding: number[], topK?: number): Promise<(PRReview & {
    similarity: number;
})[]>;
export declare function searchSimilarCode(embedding: number[], topK?: number): Promise<(RepoKnowledge & {
    similarity: number;
})[]>;
export declare function findReviewersByFiles(filePaths: string[], topK?: number): Promise<{
    reviewer_login: string;
    review_count: number;
    files: string[];
}[]>;
export declare function findCodeTouchersByFiles(filePaths: string[], topK?: number): Promise<{
    author_login: string;
    change_count: number;
    files: string[];
}[]>;
export declare function getDistinctRepos(): Promise<{
    org: string;
    repo: string;
}[]>;
export { pool };
//# sourceMappingURL=client.d.ts.map