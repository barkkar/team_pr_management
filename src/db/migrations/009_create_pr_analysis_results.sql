-- Store AI analysis results for PRs
CREATE TABLE IF NOT EXISTS pr_analysis_results (
  id SERIAL PRIMARY KEY,
  pr_url TEXT NOT NULL UNIQUE,
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  review_json JSONB NOT NULL DEFAULT '{}',
  reviewers_json JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pr_analysis_results_url ON pr_analysis_results (pr_url);
