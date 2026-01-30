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

export async function markPRClosed(id: number): Promise<void> {
  await pool.query('UPDATE tracked_prs SET pr_closed = TRUE WHERE id = $1', [id]);
}

export async function getTrackedPRByUrl(prUrl: string): Promise<TrackedPR | null> {
  const result = await pool.query('SELECT * FROM tracked_prs WHERE pr_url = $1', [prUrl]);
  return result.rows[0] || null;
}

export { pool };
