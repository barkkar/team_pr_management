-- Ontology-based code rule engine
-- Replaces fuzzy vector similarity for rule retrieval with deterministic lookup

-- Domains: hierarchical categories (e.g., entity → entity/fields → entity/fields/validation)
CREATE TABLE IF NOT EXISTS code_domains (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  parent_id INTEGER REFERENCES code_domains(id),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_code_domains_parent ON code_domains(parent_id);
CREATE INDEX IF NOT EXISTS idx_code_domains_name ON code_domains(name);

-- Rules: the actual coding rules, each belonging to a domain
CREATE TABLE IF NOT EXISTS code_rules (
  id SERIAL PRIMARY KEY,
  domain_id INTEGER NOT NULL REFERENCES code_domains(id),
  rule_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'high',
  enabled BOOLEAN DEFAULT TRUE,
  team_owner TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_code_rules_domain ON code_rules(domain_id);
CREATE INDEX IF NOT EXISTS idx_code_rules_team ON code_rules(team_owner);
CREATE INDEX IF NOT EXISTS idx_code_rules_enabled ON code_rules(enabled);

-- Deterministic matchers: file patterns, code patterns, metadata that trigger rules
CREATE TABLE IF NOT EXISTS rule_matchers (
  id SERIAL PRIMARY KEY,
  rule_id INTEGER NOT NULL REFERENCES code_rules(id) ON DELETE CASCADE,
  matcher_type TEXT NOT NULL,
  pattern TEXT NOT NULL,
  is_regex BOOLEAN DEFAULT FALSE,
  priority INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rule_matchers_type ON rule_matchers(matcher_type);
CREATE INDEX IF NOT EXISTS idx_rule_matchers_rule ON rule_matchers(rule_id);

-- Domain-to-file-path mappings: maps codebase structure to rule domains
CREATE TABLE IF NOT EXISTS domain_file_mappings (
  id SERIAL PRIMARY KEY,
  domain_id INTEGER NOT NULL REFERENCES code_domains(id) ON DELETE CASCADE,
  file_pattern TEXT NOT NULL,
  priority INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_domain_file_mappings_domain ON domain_file_mappings(domain_id);

-- Rule feedback: track when humans override/dismiss AI rule comments
CREATE TABLE IF NOT EXISTS rule_feedback (
  id SERIAL PRIMARY KEY,
  rule_id INTEGER NOT NULL REFERENCES code_rules(id),
  pr_url TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  feedback_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rule_feedback_rule ON rule_feedback(rule_id);
CREATE INDEX IF NOT EXISTS idx_rule_feedback_pr ON rule_feedback(pr_url);
