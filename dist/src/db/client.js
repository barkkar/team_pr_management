"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.insertTrackedPR = insertTrackedPR;
exports.getPendingReminders = getPendingReminders;
exports.cancelRemindersForMessage = cancelRemindersForMessage;
exports.markReminderSent = markReminderSent;
exports.scheduleNextReminder = scheduleNextReminder;
exports.getOpenUnreviewedPRs = getOpenUnreviewedPRs;
exports.markPRClosed = markPRClosed;
exports.getTrackedPRByUrl = getTrackedPRByUrl;
exports.getPRsNeedingStatusCheck = getPRsNeedingStatusCheck;
exports.updatePRStatus = updatePRStatus;
exports.addMonitoredChannel = addMonitoredChannel;
exports.getChannelReminderConfig = getChannelReminderConfig;
exports.setChannelReminderInterval = setChannelReminderInterval;
exports.setChannelTimezone = setChannelTimezone;
exports.removeMonitoredChannel = removeMonitoredChannel;
exports.getMonitoredChannels = getMonitoredChannels;
exports.isChannelMonitored = isChannelMonitored;
exports.getReviewStats = getReviewStats;
exports.insertPRReview = insertPRReview;
exports.getPRReviewCount = getPRReviewCount;
exports.insertPRFile = insertPRFile;
exports.upsertUserMapping = upsertUserMapping;
exports.getUserMapping = getUserMapping;
exports.getAllUserMappings = getAllUserMappings;
exports.getHarvestState = getHarvestState;
exports.upsertHarvestState = upsertHarvestState;
exports.findReviewersByFiles = findReviewersByFiles;
exports.findCodeTouchersByFiles = findCodeTouchersByFiles;
exports.getDistinctRepos = getDistinctRepos;
exports.insertBootstrapMembers = insertBootstrapMembers;
exports.claimPendingBootstrap = claimPendingBootstrap;
exports.updateBootstrapResults = updateBootstrapResults;
const pg_1 = require("pg");
const pool = new pg_1.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
exports.pool = pool;
async function insertTrackedPR(pr) {
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
async function getPendingReminders() {
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
async function cancelRemindersForMessage(channelId, messageTs, cancelledBy) {
    const result = await pool.query(`UPDATE tracked_prs
       SET reminders_cancelled = TRUE,
           cancelled_by = COALESCE(cancelled_by, $3),
           cancelled_at = COALESCE(cancelled_at, NOW())
     WHERE channel_id = $1 AND message_ts = $2
     RETURNING pr_url`, [channelId, messageTs, cancelledBy]);
    return result.rows.map(r => r.pr_url);
}
async function markReminderSent(id) {
    await pool.query('UPDATE tracked_prs SET reminder_sent = TRUE WHERE id = $1', [id]);
}
/**
 * Schedule the next reminder (for recurring reminders).
 * Keeps reminder_sent = FALSE so the PR stays in the pending pool.
 * `nextAt` must be supplied — callers compute it from the channel's configured
 * cadence/timezone so a missed call site fails the type check rather than
 * silently using a stale 2h fallback.
 */
async function scheduleNextReminder(id, nextAt) {
    await pool.query(`UPDATE tracked_prs SET eligible_reminder_at = $2, reminder_count = COALESCE(reminder_count, 0) + 1 WHERE id = $1`, [id, nextAt]);
}
/**
 * Get all open PRs that haven't received reviews yet (for /pr-monitor pending).
 * Unlike getPendingReminders(), this is not gated by eligible_reminder_at or reminder_sent.
 */
async function getOpenUnreviewedPRs() {
    const query = `
    SELECT * FROM tracked_prs
    WHERE (is_open = TRUE OR is_open IS NULL)
      AND (has_reviews = FALSE OR has_reviews IS NULL)
    ORDER BY posted_at ASC
  `;
    const result = await pool.query(query);
    return result.rows;
}
async function markPRClosed(id) {
    await pool.query('UPDATE tracked_prs SET is_open = FALSE WHERE id = $1', [id]);
}
async function getTrackedPRByUrl(prUrl) {
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
async function getPRsNeedingStatusCheck() {
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
async function updatePRStatus(prUrl, isOpen, hasReviews) {
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
async function addMonitoredChannel(channelId, channelName, addedBy, intervalHours, timezone) {
    const insertCols = ['channel_id', 'channel_name', 'added_by'];
    const insertVals = [channelId, channelName, addedBy];
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
async function getChannelReminderConfig(channelId) {
    const result = await pool.query(`SELECT reminder_interval_hours, timezone
     FROM monitored_channels
     WHERE channel_id = $1 AND enabled = TRUE`, [channelId]);
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
async function setChannelReminderInterval(channelId, hours) {
    if (!Number.isInteger(hours) || hours < 1 || hours > 24) {
        throw new Error(`reminder_interval_hours must be an integer between 1 and 24 (got ${hours})`);
    }
    const result = await pool.query(`UPDATE monitored_channels
     SET reminder_interval_hours = $2
     WHERE channel_id = $1 AND enabled = TRUE`, [channelId, hours]);
    return (result.rowCount || 0) > 0;
}
/**
 * Update a channel's timezone. Caller must pre-validate the IANA string
 * (see `isValidTimezone` in `src/utils/timezone.ts`).
 */
async function setChannelTimezone(channelId, timezone) {
    const result = await pool.query(`UPDATE monitored_channels
     SET timezone = $2
     WHERE channel_id = $1 AND enabled = TRUE`, [channelId, timezone]);
    return (result.rowCount || 0) > 0;
}
/**
 * Remove a channel from monitoring (soft delete - sets enabled = false)
 */
async function removeMonitoredChannel(channelId) {
    const result = await pool.query('UPDATE monitored_channels SET enabled = FALSE WHERE channel_id = $1', [channelId]);
    return (result.rowCount || 0) > 0;
}
/**
 * Get all enabled monitored channels
 */
async function getMonitoredChannels() {
    const result = await pool.query('SELECT * FROM monitored_channels WHERE enabled = TRUE ORDER BY added_at ASC');
    return result.rows;
}
/**
 * Check if a channel is being monitored
 */
async function isChannelMonitored(channelId) {
    const result = await pool.query('SELECT 1 FROM monitored_channels WHERE channel_id = $1 AND enabled = TRUE', [channelId]);
    return result.rows.length > 0;
}
async function getReviewStats() {
    const total = await pool.query('SELECT COUNT(*) as count FROM tracked_prs');
    const totalTracked = parseInt(total.rows[0].count, 10);
    const reviewedNoReminder = await pool.query(`SELECT COUNT(*) as count FROM tracked_prs WHERE has_reviews = TRUE AND COALESCE(reminder_count, 0) = 0`);
    const reviewedWithoutReminders = parseInt(reviewedNoReminder.rows[0].count, 10);
    const reviewedWithReminder = await pool.query(`SELECT COUNT(*) as count FROM tracked_prs WHERE has_reviews = TRUE AND COALESCE(reminder_count, 0) > 0`);
    const reviewedAfterReminders = parseInt(reviewedWithReminder.rows[0].count, 10);
    const awaiting = await pool.query(`SELECT COUNT(*) as count FROM tracked_prs WHERE (is_open = TRUE OR is_open IS NULL) AND (has_reviews = FALSE OR has_reviews IS NULL)`);
    const stillAwaiting = parseInt(awaiting.rows[0].count, 10);
    const closedResult = await pool.query(`SELECT COUNT(*) as count FROM tracked_prs WHERE is_open = FALSE`);
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
    const reminderBreakdown = breakdown.rows.map((r) => ({
        reminders: r.reminders,
        count: parseInt(r.count, 10),
    }));
    const avgResult = await pool.query(`SELECT COALESCE(AVG(reminder_count), 0) as avg FROM tracked_prs WHERE has_reviews = TRUE AND COALESCE(reminder_count, 0) > 0`);
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
// --- PR Reviews ---
async function insertPRReview(review) {
    const query = `
    INSERT INTO pr_reviews (pr_url, pr_number, org, repo, reviewer_login, file_path, diff_hunk, comment_body, review_state, submitted_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `;
    const result = await pool.query(query, [
        review.pr_url, review.pr_number, review.org, review.repo,
        review.reviewer_login, review.file_path, review.diff_hunk,
        review.comment_body, review.review_state, review.submitted_at,
    ]);
    return result.rows[0] || null;
}
async function getPRReviewCount(prUrl) {
    const result = await pool.query('SELECT COUNT(*) as count FROM pr_reviews WHERE pr_url = $1', [prUrl]);
    return parseInt(result.rows[0].count, 10);
}
// --- PR Files ---
async function insertPRFile(file) {
    const query = `
    INSERT INTO pr_files (pr_url, pr_number, org, repo, file_path, change_type, additions, deletions, patch_snippet, author_login)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `;
    const result = await pool.query(query, [
        file.pr_url, file.pr_number, file.org, file.repo,
        file.file_path, file.change_type, file.additions, file.deletions,
        file.patch_snippet, file.author_login,
    ]);
    return result.rows[0] || null;
}
// --- User Mappings ---
async function upsertUserMapping(mapping, client = pool) {
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
async function getUserMapping(gheLogin) {
    const result = await pool.query('SELECT * FROM user_mappings WHERE ghe_login = $1', [gheLogin]);
    return result.rows[0] || null;
}
async function getAllUserMappings() {
    const result = await pool.query('SELECT * FROM user_mappings ORDER BY ghe_login');
    return result.rows;
}
// --- Harvest State ---
async function getHarvestState(org, repo) {
    const result = await pool.query('SELECT * FROM harvest_state WHERE org = $1 AND repo = $2', [org, repo]);
    return result.rows[0] || null;
}
async function upsertHarvestState(org, repo, lastPrNumber) {
    await pool.query(`
    INSERT INTO harvest_state (org, repo, last_harvested_pr_number, last_harvested_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (org, repo) DO UPDATE SET
      last_harvested_pr_number = $3,
      last_harvested_at = NOW()
  `, [org, repo, lastPrNumber]);
}
// --- Repo Knowledge ---
// --- Reviewer discovery (file + code-history based) ---
async function findReviewersByFiles(filePaths, topK = 10) {
    // Extract unique parent directories for fuzzy matching
    const dirs = [...new Set(filePaths.map(f => f.split('/').slice(0, -1).join('/')).filter(d => d.length > 0))];
    const dirPatterns = dirs.map(d => d + '/%');
    const result = await pool.query(`
    SELECT reviewer_login, COUNT(*) as review_count,
           array_agg(DISTINCT file_path) as files
    FROM pr_reviews
    WHERE file_path = ANY($1)
       OR file_path LIKE ANY($3)
    GROUP BY reviewer_login
    ORDER BY review_count DESC
    LIMIT $2
  `, [filePaths, topK, dirPatterns]);
    return result.rows;
}
async function findCodeTouchersByFiles(filePaths, topK = 10) {
    // Extract unique parent directories for fuzzy matching
    const dirs = [...new Set(filePaths.map(f => f.split('/').slice(0, -1).join('/')).filter(d => d.length > 0))];
    const dirPatterns = dirs.map(d => d + '/%');
    const result = await pool.query(`
    SELECT author_login, COUNT(*) as change_count,
           array_agg(DISTINCT file_path) as files
    FROM pr_files
    WHERE (file_path = ANY($1) OR file_path LIKE ANY($3)) AND author_login IS NOT NULL
    GROUP BY author_login
    ORDER BY change_count DESC
    LIMIT $2
  `, [filePaths, topK, dirPatterns]);
    return result.rows;
}
async function getDistinctRepos() {
    const result = await pool.query('SELECT DISTINCT org, repo FROM tracked_prs ORDER BY org, repo');
    return result.rows;
}
// ========== Channel Bootstrap Queue ==========
/**
 * Insert a batch of channel bootstrap member rows. Duplicates (same
 * channel_id + slack_user_id) are silently skipped. Returns the number of
 * freshly inserted rows.
 */
async function insertBootstrapMembers(rows) {
    if (rows.length === 0) {
        return 0;
    }
    const values = [];
    const placeholders = [];
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
async function claimPendingBootstrap(limit) {
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
    return result.rows;
}
/**
 * Apply a batch of bootstrap resolution results inside a single transaction.
 * - `resolved`: marks row resolved and upserts into user_mappings.
 * - `unresolved`: marks row unresolved (permanent miss).
 * - `pending`: increments attempts, clears the claim, and ages out to
 *   'aged_out' once the attempt count reaches 3.
 */
async function updateBootstrapResults(results) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const result of results) {
            if (result.status === 'resolved') {
                await client.query(`UPDATE channel_bootstrap_members
           SET status = 'resolved', resolved_at = NOW()
           WHERE id = $1`, [result.id]);
                await upsertUserMapping({
                    ghe_login: result.ghe_login,
                    slack_user_id: result.slack_user_id,
                    display_name: result.display_name,
                    email: result.email,
                    discovered_via: 'bootstrap_search',
                }, client);
            }
            else if (result.status === 'unresolved') {
                await client.query(`UPDATE channel_bootstrap_members
           SET status = 'unresolved', resolved_at = NOW()
           WHERE id = $1`, [result.id]);
            }
            else {
                // pending — increment attempts, clear claim, age out if >= 3.
                await client.query(`UPDATE channel_bootstrap_members
           SET attempts = attempts + 1,
               last_error = $2,
               claimed_at = NULL,
               status = CASE WHEN attempts + 1 >= 3 THEN 'aged_out' ELSE 'pending' END
           WHERE id = $1`, [result.id, result.last_error]);
            }
        }
        await client.query('COMMIT');
    }
    catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
    finally {
        client.release();
    }
}
//# sourceMappingURL=client.js.map