-- Per-comment feedback from Slack users on individual AI review suggestions
CREATE TABLE IF NOT EXISTS ai_comment_feedback (
  id SERIAL PRIMARY KEY,
  pr_url TEXT NOT NULL,
  comment_index INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('helpful', 'not_helpful')),
  comment_snapshot JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (pr_url, comment_index, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_comment_feedback_pr ON ai_comment_feedback (pr_url);
CREATE INDEX IF NOT EXISTS idx_ai_comment_feedback_rating ON ai_comment_feedback (rating, created_at DESC);
