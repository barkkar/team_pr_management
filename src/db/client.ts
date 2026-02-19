import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

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
  // New fields for worker status
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

export async function insertTrackedPR(pr: Omit<TrackedPR, 'id' | 'reminder_sent' | 'pr_closed' | 'created_at'>): Promise<TrackedPR | null> {
  const query = `
    INSERT INTO tracked_prs (pr_url, org, repo, pr_number, channel_id, message_ts, posted_at, eligible_reminder_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (pr_url) DO NOTHING
    RETURNING *
  `;
  const values = [
    pr.pr_url,
    pr.org,
    pr.repo,
    pr.pr_number,
    pr.channel_id,
    pr.message_ts,
    pr.posted_at,
    pr.eligible_reminder_at,
  ];
  
  const result = await pool.query(query, values);
  return result.rows[0] || null;
}

export async function getPendingReminders(): Promise<TrackedPR[]> {
  const query = `
    SELECT * FROM tracked_prs
    WHERE reminder_sent = FALSE
      AND pr_closed = FALSE
      AND eligible_reminder_at <= NOW()
    ORDER BY eligible_reminder_at ASC
  `;
  const result = await pool.query(query);
  return result.rows;
}

export async function markReminderSent(id: number): Promise<void> {
  await pool.query('UPDATE tracked_prs SET reminder_sent = TRUE WHERE id = $1', [id]);
}

/**
 * Schedule the next reminder in 2 hours (for recurring reminders).
 * Keeps reminder_sent = FALSE so the PR stays in the pending pool.
 */
export async function scheduleNextReminder(id: number): Promise<void> {
  await pool.query(
    `UPDATE tracked_prs SET eligible_reminder_at = NOW() + INTERVAL '2 hours' WHERE id = $1`,
    [id],
  );
}

export async function markPRClosed(id: number): Promise<void> {
  await pool.query('UPDATE tracked_prs SET pr_closed = TRUE WHERE id = $1', [id]);
}

export async function getTrackedPRByUrl(prUrl: string): Promise<TrackedPR | null> {
  const result = await pool.query('SELECT * FROM tracked_prs WHERE pr_url = $1', [prUrl]);
  return result.rows[0] || null;
}

// ========== Worker Status Functions ==========

/**
 * Get PRs that need status checking by the worker
 * Returns PRs that:
 * - Haven't had reminder sent
 * - Aren't closed
 * - Haven't been checked in the last 5 minutes
 */
export async function getPRsNeedingStatusCheck(): Promise<TrackedPR[]> {
  const query = `
    SELECT * FROM tracked_prs
    WHERE reminder_sent = FALSE
      AND pr_closed = FALSE
      AND (status_checked_at IS NULL OR status_checked_at < NOW() - INTERVAL '5 minutes')
    ORDER BY status_checked_at ASC NULLS FIRST, created_at ASC
    LIMIT 50
  `;
  const result = await pool.query(query);
  return result.rows;
}

/**
 * Update PR status from worker
 */
export async function updatePRStatus(prUrl: string, isOpen: boolean, hasReviews: boolean): Promise<void> {
  const query = `
    UPDATE tracked_prs 
    SET is_open = $2, 
        has_reviews = $3, 
        status_checked_at = NOW(),
        pr_closed = CASE WHEN $2 = FALSE THEN TRUE ELSE pr_closed END
    WHERE pr_url = $1
  `;
  await pool.query(query, [prUrl, isOpen, hasReviews]);
}

// ========== Monitored Channels Functions ==========

/**
 * Add a channel to monitoring
 */
export async function addMonitoredChannel(channelId: string, channelName: string | null, addedBy: string): Promise<MonitoredChannel | null> {
  const query = `
    INSERT INTO monitored_channels (channel_id, channel_name, added_by)
    VALUES ($1, $2, $3)
    ON CONFLICT (channel_id) DO UPDATE SET enabled = TRUE, channel_name = COALESCE($2, monitored_channels.channel_name)
    RETURNING *
  `;
  const result = await pool.query(query, [channelId, channelName, addedBy]);
  return result.rows[0] || null;
}

/**
 * Remove a channel from monitoring (soft delete - sets enabled = false)
 */
export async function removeMonitoredChannel(channelId: string): Promise<boolean> {
  const result = await pool.query(
    'UPDATE monitored_channels SET enabled = FALSE WHERE channel_id = $1',
    [channelId]
  );
  return (result.rowCount || 0) > 0;
}

/**
 * Get all enabled monitored channels
 */
export async function getMonitoredChannels(): Promise<MonitoredChannel[]> {
  const result = await pool.query(
    'SELECT * FROM monitored_channels WHERE enabled = TRUE ORDER BY added_at ASC'
  );
  return result.rows;
}

/**
 * Check if a channel is being monitored
 */
export async function isChannelMonitored(channelId: string): Promise<boolean> {
  const result = await pool.query(
    'SELECT 1 FROM monitored_channels WHERE channel_id = $1 AND enabled = TRUE',
    [channelId]
  );
  return result.rows.length > 0;
}

export { pool };
