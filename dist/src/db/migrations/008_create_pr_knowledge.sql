-- PR review comments harvested from closed PRs
CREATE TABLE IF NOT EXISTS pr_reviews (
  id SERIAL PRIMARY KEY,
  pr_url TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  reviewer_login TEXT NOT NULL,
  file_path TEXT,
  diff_hunk TEXT,
  comment_body TEXT NOT NULL,
  review_state TEXT NOT NULL,
  submitted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pr_reviews_repo ON pr_reviews (org, repo);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_reviewer ON pr_reviews (reviewer_login);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_file ON pr_reviews (file_path);

-- Files changed per PR
CREATE TABLE IF NOT EXISTS pr_files (
  id SERIAL PRIMARY KEY,
  pr_url TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  file_path TEXT NOT NULL,
  change_type TEXT NOT NULL,
  additions INTEGER DEFAULT 0,
  deletions INTEGER DEFAULT 0,
  patch_snippet TEXT,
  author_login TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pr_files_repo ON pr_files (org, repo);
CREATE INDEX IF NOT EXISTS idx_pr_files_file ON pr_files (file_path);
CREATE INDEX IF NOT EXISTS idx_pr_files_author ON pr_files (author_login);

-- Vector embeddings for RAG
CREATE TABLE IF NOT EXISTS pr_embeddings (
  id SERIAL PRIMARY KEY,
  content_type TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  content_text TEXT NOT NULL,
  embedding vector(768),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pr_embeddings_type ON pr_embeddings (content_type);
CREATE INDEX IF NOT EXISTS idx_pr_embeddings_vector ON pr_embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- GHE login <-> Slack user ID mapping
CREATE TABLE IF NOT EXISTS user_mappings (
  id SERIAL PRIMARY KEY,
  ghe_login TEXT NOT NULL UNIQUE,
  slack_user_id TEXT,
  display_name TEXT,
  email TEXT,
  discovered_via TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_mappings_slack ON user_mappings (slack_user_id);

-- Codebase knowledge chunks from git repos
CREATE TABLE IF NOT EXISTS repo_knowledge (
  id SERIAL PRIMARY KEY,
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_chunk TEXT NOT NULL,
  chunk_index INTEGER DEFAULT 0,
  embedding vector(768),
  last_commit_sha TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repo_knowledge_repo ON repo_knowledge (org, repo);
CREATE INDEX IF NOT EXISTS idx_repo_knowledge_file ON repo_knowledge (file_path);
CREATE INDEX IF NOT EXISTS idx_repo_knowledge_vector ON repo_knowledge
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Harvest state tracking for incremental harvesting
CREATE TABLE IF NOT EXISTS harvest_state (
  id SERIAL PRIMARY KEY,
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  last_harvested_pr_number INTEGER DEFAULT 0,
  last_repo_harvest_sha TEXT,
  last_harvested_at TIMESTAMP,
  last_repo_harvested_at TIMESTAMP,
  UNIQUE(org, repo)
);
