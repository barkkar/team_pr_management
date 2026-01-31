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
}
export declare function insertTrackedPR(pr: Omit<TrackedPR, 'id' | 'reminder_sent' | 'pr_closed' | 'created_at'>): Promise<TrackedPR | null>;
export declare function getPendingReminders(): Promise<TrackedPR[]>;
export declare function markReminderSent(id: number): Promise<void>;
export declare function markPRClosed(id: number): Promise<void>;
export declare function getTrackedPRByUrl(prUrl: string): Promise<TrackedPR | null>;
export { pool };
//# sourceMappingURL=client.d.ts.map