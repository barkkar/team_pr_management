"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.insertTrackedPR = insertTrackedPR;
exports.getPendingReminders = getPendingReminders;
exports.markReminderSent = markReminderSent;
exports.scheduleNextReminder = scheduleNextReminder;
exports.markPRClosed = markPRClosed;
exports.getTrackedPRByUrl = getTrackedPRByUrl;
exports.getPRsNeedingStatusCheck = getPRsNeedingStatusCheck;
exports.updatePRStatus = updatePRStatus;
exports.addMonitoredChannel = addMonitoredChannel;
exports.removeMonitoredChannel = removeMonitoredChannel;
exports.getMonitoredChannels = getMonitoredChannels;
exports.isChannelMonitored = isChannelMonitored;
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
      AND pr_closed = FALSE
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
    await pool.query(`UPDATE tracked_prs SET eligible_reminder_at = NOW() + INTERVAL '2 hours' WHERE id = $1`, [id]);
}
async function markPRClosed(id) {
    await pool.query('UPDATE tracked_prs SET pr_closed = TRUE WHERE id = $1', [id]);
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
async function updatePRStatus(prUrl, isOpen, hasReviews) {
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
//# sourceMappingURL=client.js.map