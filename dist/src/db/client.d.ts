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
    pr_closed: boolean;
    created_at: Date;
    has_reviews?: boolean;
    is_open?: boolean;
    status_checked_at?: Date;
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
export declare function insertTrackedPR(pr: Omit<TrackedPR, 'id' | 'reminder_sent' | 'pr_closed' | 'created_at'>): Promise<TrackedPR | null>;
export declare function getPendingReminders(): Promise<TrackedPR[]>;
export declare function markReminderSent(id: number): Promise<void>;
export declare function markPRClosed(id: number): Promise<void>;
export declare function getTrackedPRByUrl(prUrl: string): Promise<TrackedPR | null>;
/**
 * Get PRs that need status checking by the worker
 * Returns PRs that:
 * - Haven't had reminder sent
 * - Aren't closed
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
export { pool };
//# sourceMappingURL=client.d.ts.map