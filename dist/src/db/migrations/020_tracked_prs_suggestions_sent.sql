-- Mark tracked PRs once the reviewer-suggestion worker has processed them.

ALTER TABLE tracked_prs
  ADD COLUMN IF NOT EXISTS suggestions_sent BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_tracked_prs_suggestions_pending
  ON tracked_prs (suggestions_sent, created_at)
  WHERE suggestions_sent = FALSE;
