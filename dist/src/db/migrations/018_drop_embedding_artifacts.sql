-- Remove pgvector-backed embedding artifacts after dropping Ollama integration.
-- Keeps the `vector` extension enabled (harmless) and the business columns intact.

-- Embedding index + column on ai_review_lessons
DROP INDEX IF EXISTS idx_ai_review_lessons_embedding;
ALTER TABLE IF EXISTS ai_review_lessons DROP COLUMN IF EXISTS embedding;

-- Embedding index + column on repo_knowledge
DROP INDEX IF EXISTS idx_repo_knowledge_vector;
ALTER TABLE IF EXISTS repo_knowledge DROP COLUMN IF EXISTS embedding;

-- Team documents feature removed
DROP INDEX IF EXISTS idx_team_documents_embedding;
DROP INDEX IF EXISTS idx_team_documents_type;
DROP INDEX IF EXISTS idx_team_documents_source;
DROP TABLE IF EXISTS team_documents;

-- Generic embeddings table removed
DROP INDEX IF EXISTS idx_pr_embeddings_vector;
DROP INDEX IF EXISTS idx_pr_embeddings_type;
DROP TABLE IF EXISTS pr_embeddings;
