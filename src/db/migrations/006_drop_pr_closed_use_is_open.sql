-- Migrate pr_closed data to is_open, then drop pr_closed
-- Rows with pr_closed = TRUE should have is_open = FALSE
UPDATE tracked_prs SET is_open = FALSE WHERE pr_closed = TRUE;

-- Drop indexes that reference pr_closed
DROP INDEX IF EXISTS idx_tracked_prs_pending;
DROP INDEX IF EXISTS idx_tracked_prs_status_check;

-- Drop pr_closed column
ALTER TABLE tracked_prs DROP COLUMN IF EXISTS pr_closed;

-- Recreate indexes using is_open
CREATE INDEX IF NOT EXISTS idx_tracked_prs_pending ON tracked_prs (eligible_reminder_at)
  WHERE reminder_sent = FALSE AND (is_open = TRUE OR is_open IS NULL);

CREATE INDEX IF NOT EXISTS idx_tracked_prs_status_check ON tracked_prs (reminder_sent, status_checked_at)
  WHERE (is_open = TRUE OR is_open IS NULL);
