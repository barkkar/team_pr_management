-- Migration 017: Add domain context and code element metadata to repo_knowledge
-- Purpose: Enable domain-scoped code example retrieval for PR reviews

-- Add metadata columns to repo_knowledge
ALTER TABLE repo_knowledge
  ADD COLUMN domain_id INTEGER REFERENCES code_domains(id),
  ADD COLUMN code_element_type TEXT CHECK (code_element_type IN ('class', 'function', 'interface', 'test', 'config', 'unknown')),
  ADD COLUMN code_element_name TEXT;

-- Index for fast domain filtering
CREATE INDEX idx_repo_knowledge_domain ON repo_knowledge(domain_id);

-- Index for element type filtering
CREATE INDEX idx_repo_knowledge_element ON repo_knowledge(code_element_type);

-- Composite index for combined queries (domain + element type)
CREATE INDEX idx_repo_knowledge_domain_element ON repo_knowledge(domain_id, code_element_type) WHERE domain_id IS NOT NULL;

-- Add comments for documentation
COMMENT ON COLUMN repo_knowledge.domain_id IS 'Foreign key to code_domains, computed during harvesting using domain_file_mappings';
COMMENT ON COLUMN repo_knowledge.code_element_type IS 'Type of code element: class, function, interface, test, config, unknown';
COMMENT ON COLUMN repo_knowledge.code_element_name IS 'Extracted name of the code element (e.g., function name, class name)';
