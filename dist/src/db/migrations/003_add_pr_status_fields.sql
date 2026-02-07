-- Add fields to track PR status from worker
ALTER TABLE tracked_prs ADD COLUMN IF NOT EXISTS has_reviews BOOLEAN DEFAULT FALSE;
ALTER TABLE tracked_prs ADD COLUMN IF NOT EXISTS is_open BOOLEAN DEFAULT TRUE;
ALTER TABLE tracked_prs ADD COLUMN IF NOT EXISTS status_checked_at TIMESTAMP;

-- Index for finding PRs that need status checking
CREATE INDEX IF NOT EXISTS idx_tracked_prs_status_check 
ON tracked_prs (reminder_sent, pr_closed, status_checked_at);
