-- Add reminder_count to track how many reminders have been sent per PR
ALTER TABLE tracked_prs ADD COLUMN IF NOT EXISTS reminder_count INTEGER DEFAULT 0;
