-- Automated lessons from comparing AI review vs actual peer review comments
CREATE TABLE IF NOT EXISTS ai_review_lessons (
  id SERIAL PRIMARY KEY,
  pr_url TEXT NOT NULL UNIQUE,
  ai_review_json JSONB NOT NULL DEFAULT '{}',
  peer_comments_json JSONB NOT NULL DEFAULT '[]',
  lessons_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_review_lessons_pr ON ai_review_lessons (pr_url);
CREATE INDEX IF NOT EXISTS idx_ai_review_lessons_created ON ai_review_lessons (created_at DESC);
