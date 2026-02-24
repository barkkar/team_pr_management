-- Team documents (design docs, requirements, runbooks) for AI review context
CREATE TABLE IF NOT EXISTS team_documents (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  doc_type TEXT DEFAULT 'design',
  content_chunk TEXT NOT NULL,
  chunk_index INTEGER DEFAULT 0,
  embedding vector(768),
  last_fetched_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_documents_source ON team_documents (source_url);
CREATE INDEX IF NOT EXISTS idx_team_documents_type ON team_documents (doc_type);
CREATE INDEX IF NOT EXISTS idx_team_documents_embedding
  ON team_documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 10);
