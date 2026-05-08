import { Pool, PoolClient } from 'pg';
import { BootstrapClaim, BootstrapResult } from '../types/channelBootstrap';

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
  created_at: Date;
  // New fields for worker status
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

export async function insertTrackedPR(pr: Omit<TrackedPR, 'id' | 'reminder_sent' | 'created_at'>): Promise<TrackedPR | null> {
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
      AND (is_open = TRUE OR is_open IS NULL)
      AND (reminders_cancelled = FALSE OR reminders_cancelled IS NULL)
      AND eligible_reminder_at <= NOW()
    ORDER BY eligible_reminder_at ASC
  `;
  const result = await pool.query(query);
  return result.rows;
}

/**
 * Silence reminders for every PR tracked against a specific Slack message.
 * Triggered by the `cancel_reminder` message shortcut. COALESCE preserves
 * the original canceller's identity on repeat invocations.
 */
export async function cancelRemindersForMessage(
  channelId: string,
  messageTs: string,
  cancelledBy: string,
): Promise<string[]> {
  const result = await pool.query(
    `UPDATE tracked_prs
       SET reminders_cancelled = TRUE,
           cancelled_by = COALESCE(cancelled_by, $3),
           cancelled_at = COALESCE(cancelled_at, NOW())
     WHERE channel_id = $1 AND message_ts = $2
     RETURNING pr_url`,
    [channelId, messageTs, cancelledBy],
  );
  return result.rows.map(r => r.pr_url);
}

export async function markReminderSent(id: number): Promise<void> {
  await pool.query('UPDATE tracked_prs SET reminder_sent = TRUE WHERE id = $1', [id]);
}

/**
 * Schedule the next reminder (for recurring reminders).
 * Keeps reminder_sent = FALSE so the PR stays in the pending pool.
 * `nextAt` must be supplied — callers compute it from the channel's configured
 * cadence/timezone so a missed call site fails the type check rather than
 * silently using a stale 2h fallback.
 */
export async function scheduleNextReminder(id: number, nextAt: Date): Promise<void> {
  await pool.query(
    `UPDATE tracked_prs SET eligible_reminder_at = $2, reminder_count = COALESCE(reminder_count, 0) + 1 WHERE id = $1`,
    [id, nextAt],
  );
}

/**
 * Get all open PRs that haven't received reviews yet (for /pr-monitor pending).
 * Unlike getPendingReminders(), this is not gated by eligible_reminder_at or reminder_sent.
 */
export async function getOpenUnreviewedPRs(): Promise<TrackedPR[]> {
  const query = `
    SELECT * FROM tracked_prs
    WHERE (is_open = TRUE OR is_open IS NULL)
      AND (has_reviews = FALSE OR has_reviews IS NULL)
    ORDER BY posted_at ASC
  `;
  const result = await pool.query(query);
  return result.rows;
}

export async function markPRClosed(id: number): Promise<void> {
  await pool.query('UPDATE tracked_prs SET is_open = FALSE WHERE id = $1', [id]);
}

export async function getTrackedPRByUrl(prUrl: string): Promise<TrackedPR | null> {
  const result = await pool.query('SELECT * FROM tracked_prs WHERE pr_url = $1', [prUrl]);
  return result.rows[0] || null;
}

// ========== Worker Status Functions ==========

/**
 * Get PRs that need status checking by the worker
 * Returns PRs that:
 * - Are open or unknown (not known to be closed)
 * - Haven't been checked in the last 5 minutes
 */
export async function getPRsNeedingStatusCheck(): Promise<TrackedPR[]> {
  const query = `
    SELECT * FROM tracked_prs
    WHERE (is_open = TRUE OR is_open IS NULL)
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
        status_checked_at = NOW()
    WHERE pr_url = $1
  `;
  await pool.query(query, [prUrl, isOpen, hasReviews]);
}

// ========== Monitored Channels Functions ==========

/**
 * Add a channel to monitoring. Optional `intervalHours` / `timezone` overrides
 * apply to both the fresh insert and the ON CONFLICT re-enable branch (so
 * re-adding with new flags overwrites existing config). When omitted on a
 * brand-new row, DB defaults take over; when omitted on a re-enable, the
 * existing config is preserved.
 */
export async function addMonitoredChannel(
  channelId: string,
  channelName: string | null,
  addedBy: string,
  intervalHours?: number,
  timezone?: string,
): Promise<MonitoredChannel | null> {
  const insertCols = ['channel_id', 'channel_name', 'added_by'];
  const insertVals: (string | number | null)[] = [channelId, channelName, addedBy];
  const updateClauses = [
    'enabled = TRUE',
    'channel_name = COALESCE($2, monitored_channels.channel_name)',
  ];
  if (intervalHours !== undefined) {
    insertVals.push(intervalHours);
    insertCols.push('reminder_interval_hours');
    updateClauses.push(`reminder_interval_hours = $${insertVals.length}`);
  }
  if (timezone !== undefined) {
    insertVals.push(timezone);
    insertCols.push('timezone');
    updateClauses.push(`timezone = $${insertVals.length}`);
  }
  const placeholders = insertVals.map((_, i) => `$${i + 1}`).join(', ');

  const query = `
    INSERT INTO monitored_channels (${insertCols.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT (channel_id) DO UPDATE SET ${updateClauses.join(', ')}
    RETURNING *
  `;
  const result = await pool.query(query, insertVals);
  return result.rows[0] || null;
}

/**
 * Look up a channel's reminder cadence + timezone. Falls back to the system
 * defaults (2h, America/Los_Angeles) when the channel is not enabled in
 * monitored_channels — this covers the legacy `POLL_CHANNEL_IDS` env-var path
 * (see `src/services/channelPoller.ts`) which polls channels that may never
 * have been registered via `/pr-monitor add`.
 */
export async function getChannelReminderConfig(
  channelId: string,
): Promise<{ intervalHours: number; timezone: string }> {
  const result = await pool.query(
    `SELECT reminder_interval_hours, timezone
     FROM monitored_channels
     WHERE channel_id = $1 AND enabled = TRUE`,
    [channelId],
  );
  if (result.rows.length === 0) {
    return { intervalHours: 2, timezone: 'America/Los_Angeles' };
  }
  return {
    intervalHours: result.rows[0].reminder_interval_hours,
    timezone: result.rows[0].timezone,
  };
}

/**
 * Update a channel's reminder cadence. Returns true if a row was updated.
 * Throws on invalid input (must be an integer 1–24).
 */
export async function setChannelReminderInterval(
  channelId: string,
  hours: number,
): Promise<boolean> {
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
    throw new Error(`reminder_interval_hours must be an integer between 1 and 24 (got ${hours})`);
  }
  const result = await pool.query(
    `UPDATE monitored_channels
     SET reminder_interval_hours = $2
     WHERE channel_id = $1 AND enabled = TRUE`,
    [channelId, hours],
  );
  return (result.rowCount || 0) > 0;
}

/**
 * Update a channel's timezone. Caller must pre-validate the IANA string
 * (see `isValidTimezone` in `src/utils/timezone.ts`).
 */
export async function setChannelTimezone(
  channelId: string,
  timezone: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE monitored_channels
     SET timezone = $2
     WHERE channel_id = $1 AND enabled = TRUE`,
    [channelId, timezone],
  );
  return (result.rowCount || 0) > 0;
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

// ========== Statistics Functions ==========

export interface ReviewStats {
  totalTracked: number;
  reviewedWithoutReminders: number;
  reviewedAfterReminders: number;
  stillAwaiting: number;
  closed: number;
  reminderBreakdown: { reminders: string; count: number }[];
  avgRemindersBeforeReview: number;
}

export async function getReviewStats(): Promise<ReviewStats> {
  const total = await pool.query('SELECT COUNT(*) as count FROM tracked_prs');
  const totalTracked = parseInt(total.rows[0].count, 10);

  const reviewedNoReminder = await pool.query(
    `SELECT COUNT(*) as count FROM tracked_prs WHERE has_reviews = TRUE AND COALESCE(reminder_count, 0) = 0`,
  );
  const reviewedWithoutReminders = parseInt(reviewedNoReminder.rows[0].count, 10);

  const reviewedWithReminder = await pool.query(
    `SELECT COUNT(*) as count FROM tracked_prs WHERE has_reviews = TRUE AND COALESCE(reminder_count, 0) > 0`,
  );
  const reviewedAfterReminders = parseInt(reviewedWithReminder.rows[0].count, 10);

  const awaiting = await pool.query(
    `SELECT COUNT(*) as count FROM tracked_prs WHERE (is_open = TRUE OR is_open IS NULL) AND (has_reviews = FALSE OR has_reviews IS NULL)`,
  );
  const stillAwaiting = parseInt(awaiting.rows[0].count, 10);

  const closedResult = await pool.query(
    `SELECT COUNT(*) as count FROM tracked_prs WHERE is_open = FALSE`,
  );
  const closed = parseInt(closedResult.rows[0].count, 10);

  const breakdown = await pool.query(`
    SELECT
      CASE
        WHEN COALESCE(reminder_count, 0) = 0 THEN '0'
        WHEN reminder_count = 1 THEN '1'
        WHEN reminder_count = 2 THEN '2'
        ELSE '3+'
      END as reminders,
      COUNT(*) as count
    FROM tracked_prs
    GROUP BY 1
    ORDER BY MIN(COALESCE(reminder_count, 0))
  `);
  const reminderBreakdown = breakdown.rows.map((r: any) => ({
    reminders: r.reminders,
    count: parseInt(r.count, 10),
  }));

  const avgResult = await pool.query(
    `SELECT COALESCE(AVG(reminder_count), 0) as avg FROM tracked_prs WHERE has_reviews = TRUE AND COALESCE(reminder_count, 0) > 0`,
  );
  const avgRemindersBeforeReview = parseFloat(parseFloat(avgResult.rows[0].avg).toFixed(1));

  return {
    totalTracked,
    reviewedWithoutReminders,
    reviewedAfterReminders,
    stillAwaiting,
    closed,
    reminderBreakdown,
    avgRemindersBeforeReview,
  };
}

// ========== AI Knowledge Base Functions ==========

export interface UserMapping {
  id: number;
  ghe_login: string;
  slack_user_id: string | null;
  display_name: string | null;
  email: string | null;
  discovered_via: string;
  updated_at: Date;
}

// --- User Mappings ---

export async function upsertUserMapping(
  mapping: Omit<UserMapping, 'id' | 'updated_at'>,
  client: Pool | PoolClient = pool,
): Promise<UserMapping | null> {
  const query = `
    INSERT INTO user_mappings (ghe_login, slack_user_id, display_name, email, discovered_via)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (ghe_login) DO UPDATE SET
      slack_user_id = COALESCE($2, user_mappings.slack_user_id),
      display_name = COALESCE($3, user_mappings.display_name),
      email = COALESCE($4, user_mappings.email),
      discovered_via = $5,
      updated_at = NOW()
    RETURNING *
  `;
  const result = await client.query(query, [
    mapping.ghe_login, mapping.slack_user_id, mapping.display_name,
    mapping.email, mapping.discovered_via,
  ]);
  return result.rows[0] || null;
}

export async function getUserMapping(gheLogin: string): Promise<UserMapping | null> {
  const result = await pool.query('SELECT * FROM user_mappings WHERE ghe_login = $1', [gheLogin]);
  return result.rows[0] || null;
}

export async function getAllUserMappings(): Promise<UserMapping[]> {
  const result = await pool.query('SELECT * FROM user_mappings ORDER BY ghe_login');
  return result.rows;
}

export async function getDistinctRepos(): Promise<{ org: string; repo: string }[]> {
  const result = await pool.query('SELECT DISTINCT org, repo FROM tracked_prs ORDER BY org, repo');
  return result.rows;
}

// ========== Channel Bootstrap Queue ==========

/**
 * Insert a batch of channel bootstrap member rows. Duplicates (same
 * channel_id + slack_user_id) are silently skipped. Returns the number of
 * freshly inserted rows.
 */
export async function insertBootstrapMembers(
  rows: { channel_id: string; slack_user_id: string; email: string }[],
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }

  const values: (string)[] = [];
  const placeholders: string[] = [];
  rows.forEach((row, idx) => {
    const base = idx * 3;
    placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
    values.push(row.channel_id, row.slack_user_id, row.email);
  });

  const query = `
    INSERT INTO channel_bootstrap_members (channel_id, slack_user_id, email)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (channel_id, slack_user_id) DO NOTHING
  `;
  const result = await pool.query(query, values);
  return result.rowCount ?? 0;
}

/**
 * Atomically claim up to `limit` pending bootstrap rows (and re-claim stale
 * in-progress rows whose claim has expired). Uses SELECT ... FOR UPDATE SKIP
 * LOCKED so multiple workers never double-claim the same row.
 */
export async function claimPendingBootstrap(limit: number): Promise<BootstrapClaim[]> {
  const query = `
    WITH claimed AS (
      SELECT id FROM channel_bootstrap_members
      WHERE (status = 'pending' AND attempts < 3)
         OR (status = 'in_progress' AND claimed_at < NOW() - INTERVAL '15 minutes')
      ORDER BY enqueued_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    )
    UPDATE channel_bootstrap_members c
    SET status = 'in_progress', claimed_at = NOW()
    FROM claimed WHERE c.id = claimed.id
    RETURNING c.id, c.channel_id, c.slack_user_id, c.email;
  `;
  const result = await pool.query(query, [limit]);
  return result.rows as BootstrapClaim[];
}

/**
 * Apply a batch of bootstrap resolution results inside a single transaction.
 * - `resolved`: marks row resolved and upserts into user_mappings.
 * - `unresolved`: marks row unresolved (permanent miss).
 * - `pending`: increments attempts, clears the claim, and ages out to
 *   'aged_out' once the attempt count reaches 3.
 */
export async function updateBootstrapResults(results: BootstrapResult[]): Promise<void> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const result of results) {
      if (result.status === 'resolved') {
        await client.query(
          `UPDATE channel_bootstrap_members
           SET status = 'resolved', resolved_at = NOW()
           WHERE id = $1`,
          [result.id],
        );
        await upsertUserMapping(
          {
            ghe_login: result.ghe_login,
            slack_user_id: result.slack_user_id,
            display_name: result.display_name,
            email: result.email,
            discovered_via: 'bootstrap_search',
          },
          client,
        );
      } else if (result.status === 'unresolved') {
        await client.query(
          `UPDATE channel_bootstrap_members
           SET status = 'unresolved', resolved_at = NOW()
           WHERE id = $1`,
          [result.id],
        );
      } else {
        // pending — increment attempts, clear claim, age out if >= 3.
        await client.query(
          `UPDATE channel_bootstrap_members
           SET attempts = attempts + 1,
               last_error = $2,
               claimed_at = NULL,
               status = CASE WHEN attempts + 1 >= 3 THEN 'aged_out' ELSE 'pending' END
           WHERE id = $1`,
          [result.id, result.last_error],
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getChannelMembers(
  channelId: string,
): Promise<{ ghe_login: string; slack_user_id: string; display_name: string | null; email: string | null }[]> {
  const result = await pool.query(
    `SELECT um.ghe_login, um.slack_user_id, um.display_name, um.email
     FROM channel_bootstrap_members cbm
     JOIN user_mappings um ON um.slack_user_id = cbm.slack_user_id
     WHERE cbm.channel_id = $1 AND cbm.status = 'resolved' AND um.ghe_login IS NOT NULL
     ORDER BY um.ghe_login`,
    [channelId],
  );
  return result.rows;
}

export { pool };
