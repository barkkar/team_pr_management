-- Add embedding column to ai_review_lessons for semantic similarity search
ALTER TABLE ai_review_lessons ADD COLUMN IF NOT EXISTS embedding vector(768);

-- Cosine similarity index for finding relevant lessons
CREATE INDEX IF NOT EXISTS idx_ai_review_lessons_embedding
  ON ai_review_lessons USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 10);
