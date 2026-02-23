-- Manual feedback from Slack users on AI review quality
CREATE TABLE IF NOT EXISTS ai_review_feedback (
  id SERIAL PRIMARY KEY,
  pr_url TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('helpful', 'not_helpful')),
  feedback_text TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (pr_url, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_review_feedback_pr ON ai_review_feedback (pr_url);
CREATE INDEX IF NOT EXISTS idx_ai_review_feedback_rating ON ai_review_feedback (rating, created_at DESC);
