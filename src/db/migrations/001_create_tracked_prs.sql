-- Create tracked_prs table
CREATE TABLE IF NOT EXISTS tracked_prs (
  id SERIAL PRIMARY KEY,
  pr_url TEXT NOT NULL UNIQUE,
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  posted_at TIMESTAMP NOT NULL,
  eligible_reminder_at TIMESTAMP NOT NULL,
  reminder_sent BOOLEAN DEFAULT FALSE,
  pr_closed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for efficient querying of pending reminders
CREATE INDEX IF NOT EXISTS idx_tracked_prs_pending ON tracked_prs (eligible_reminder_at)
  WHERE reminder_sent = FALSE AND pr_closed = FALSE;

-- Index for looking up PRs by URL
CREATE INDEX IF NOT EXISTS idx_tracked_prs_url ON tracked_prs (pr_url);
