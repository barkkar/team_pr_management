import { Pool, PoolClient } from 'pg';
import { BootstrapClaim, BootstrapResult } from '../types/channelBootstrap';
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
    suggestions_sent?: boolean;
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
    reminder_interval_hours: number;
    timezone: string;
}
export declare function insertTrackedPR(pr: Omit<TrackedPR, 'id' | 'reminder_sent' | 'created_at'>): Promise<TrackedPR | null>;
export declare function getPendingReminders(): Promise<TrackedPR[]>;
/**
 * Silence reminders for every PR tracked against a specific Slack message.
 * Triggered by the `cancel_reminder` message shortcut. COALESCE preserves
 * the original canceller's identity on repeat invocations.
 */
export declare function cancelRemindersForMessage(channelId: string, messageTs: string, cancelledBy: string): Promise<string[]>;
export declare function markReminderSent(id: number): Promise<void>;
/**
 * Schedule the next reminder (for recurring reminders).
 * Keeps reminder_sent = FALSE so the PR stays in the pending pool.
 * `nextAt` must be supplied — callers compute it from the channel's configured
 * cadence/timezone so a missed call site fails the type check rather than
 * silently using a stale 2h fallback.
 */
export declare function scheduleNextReminder(id: number, nextAt: Date): Promise<void>;
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
 * Add a channel to monitoring. Optional `intervalHours` / `timezone` overrides
 * apply to both the fresh insert and the ON CONFLICT re-enable branch (so
 * re-adding with new flags overwrites existing config). When omitted on a
 * brand-new row, DB defaults take over; when omitted on a re-enable, the
 * existing config is preserved.
 */
export declare function addMonitoredChannel(channelId: string, channelName: string | null, addedBy: string, intervalHours?: number, timezone?: string): Promise<MonitoredChannel | null>;
/**
 * Look up a channel's reminder cadence + timezone. Falls back to the system
 * defaults (2h, America/Los_Angeles) when the channel is not enabled in
 * monitored_channels — this covers the legacy `POLL_CHANNEL_IDS` env-var path
 * (see `src/services/channelPoller.ts`) which polls channels that may never
 * have been registered via `/pr-monitor add`.
 */
export declare function getChannelReminderConfig(channelId: string): Promise<{
    intervalHours: number;
    timezone: string;
}>;
/**
 * Update a channel's reminder cadence. Returns true if a row was updated.
 * Throws on invalid input (must be an integer 1–24).
 */
export declare function setChannelReminderInterval(channelId: string, hours: number): Promise<boolean>;
/**
 * Update a channel's timezone. Caller must pre-validate the IANA string
 * (see `isValidTimezone` in `src/utils/timezone.ts`).
 */
export declare function setChannelTimezone(channelId: string, timezone: string): Promise<boolean>;
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
export declare function insertPRReview(review: Omit<PRReview, 'id' | 'created_at'>): Promise<PRReview | null>;
export declare function getPRReviewCount(prUrl: string): Promise<number>;
export declare function insertPRFile(file: Omit<PRFile, 'id' | 'created_at'>): Promise<PRFile | null>;
export declare function upsertUserMapping(mapping: Omit<UserMapping, 'id' | 'updated_at'>, client?: Pool | PoolClient): Promise<UserMapping | null>;
export declare function getUserMapping(gheLogin: string): Promise<UserMapping | null>;
export declare function getAllUserMappings(): Promise<UserMapping[]>;
export declare function getHarvestState(org: string, repo: string): Promise<HarvestState | null>;
export declare function upsertHarvestState(org: string, repo: string, lastPrNumber: number): Promise<void>;
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
/**
 * Insert a batch of channel bootstrap member rows. Duplicates (same
 * channel_id + slack_user_id) are silently skipped. Returns the number of
 * freshly inserted rows.
 */
export declare function insertBootstrapMembers(rows: {
    channel_id: string;
    slack_user_id: string;
    email: string;
}[]): Promise<number>;
/**
 * Atomically claim up to `limit` pending bootstrap rows (and re-claim stale
 * in-progress rows whose claim has expired). Uses SELECT ... FOR UPDATE SKIP
 * LOCKED so multiple workers never double-claim the same row.
 */
export declare function claimPendingBootstrap(limit: number): Promise<BootstrapClaim[]>;
/**
 * Apply a batch of bootstrap resolution results inside a single transaction.
 * - `resolved`: marks row resolved and upserts into user_mappings.
 * - `unresolved`: marks row unresolved (permanent miss).
 * - `pending`: increments attempts, clears the claim, and ages out to
 *   'aged_out' once the attempt count reaches 3.
 */
export declare function updateBootstrapResults(results: BootstrapResult[]): Promise<void>;
export { pool };
//# sourceMappingURL=client.d.ts.map