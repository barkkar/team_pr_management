"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.insertTrackedPR = insertTrackedPR;
exports.getPendingReminders = getPendingReminders;
exports.markReminderSent = markReminderSent;
exports.scheduleNextReminder = scheduleNextReminder;
exports.getOpenUnreviewedPRs = getOpenUnreviewedPRs;
exports.markPRClosed = markPRClosed;
exports.getTrackedPRByUrl = getTrackedPRByUrl;
exports.getPRsNeedingStatusCheck = getPRsNeedingStatusCheck;
exports.updatePRStatus = updatePRStatus;
exports.addMonitoredChannel = addMonitoredChannel;
exports.removeMonitoredChannel = removeMonitoredChannel;
exports.getMonitoredChannels = getMonitoredChannels;
exports.isChannelMonitored = isChannelMonitored;
exports.getReviewStats = getReviewStats;
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
      AND eligible_reminder_at <= NOW()
    ORDER BY eligible_reminder_at ASC
  `;
    const result = await pool.query(query);
    return result.rows;
}
async function markReminderSent(id) {
    await pool.query('UPDATE tracked_prs SET reminder_sent = TRUE WHERE id = $1', [id]);
}
/**
 * Schedule the next reminder in 2 hours (for recurring reminders).
 * Keeps reminder_sent = FALSE so the PR stays in the pending pool.
 */
async function scheduleNextReminder(id) {
    await pool.query(`UPDATE tracked_prs SET eligible_reminder_at = NOW() + INTERVAL '2 hours', reminder_count = COALESCE(reminder_count, 0) + 1 WHERE id = $1`, [id]);
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
 * - Haven't had reminder sent
 * - Aren't closed
 * - Haven't been checked in the last 5 minutes
 */
async function getPRsNeedingStatusCheck() {
    const query = `
    SELECT * FROM tracked_prs
    WHERE reminder_sent = FALSE
      AND (is_open = TRUE OR is_open IS NULL)
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
 * Add a channel to monitoring
 */
async function addMonitoredChannel(channelId, channelName, addedBy) {
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
//# sourceMappingURL=client.js.map