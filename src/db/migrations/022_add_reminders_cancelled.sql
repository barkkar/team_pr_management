-- Allow team members to silence reminders for a specific Slack message via
-- the `cancel_reminder` message shortcut. Cancellation is scoped to the
-- (channel_id, message_ts) pair, so every PR link in that message is silenced.
ALTER TABLE tracked_prs ADD COLUMN IF NOT EXISTS reminders_cancelled BOOLEAN DEFAULT FALSE;
ALTER TABLE tracked_prs ADD COLUMN IF NOT EXISTS cancelled_by TEXT;
ALTER TABLE tracked_prs ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
