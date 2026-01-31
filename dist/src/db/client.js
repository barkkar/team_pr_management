"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.insertTrackedPR = insertTrackedPR;
exports.getPendingReminders = getPendingReminders;
exports.markReminderSent = markReminderSent;
exports.markPRClosed = markPRClosed;
exports.getTrackedPRByUrl = getTrackedPRByUrl;
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
async function markPRClosed(id) {
    await pool.query('UPDATE tracked_prs SET pr_closed = TRUE WHERE id = $1', [id]);
}
async function getTrackedPRByUrl(prUrl) {
    const result = await pool.query('SELECT * FROM tracked_prs WHERE pr_url = $1', [prUrl]);
    return result.rows[0] || null;
}
//# sourceMappingURL=client.js.map