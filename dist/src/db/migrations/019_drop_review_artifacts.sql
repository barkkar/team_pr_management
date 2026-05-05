-- Drop review-generation artifacts. Reviewer suggestions use tracked_prs +
-- pr_reviews + pr_files + user_mappings only.
--
-- FK ORDER (verified against migrations 015 + 017):
--   rule_matchers  -> code_rules       (ON DELETE CASCADE)
--   rule_feedback  -> code_rules       (no cascade)
--   code_rules     -> code_domains
--   domain_file_mappings -> code_domains (ON DELETE CASCADE)
--   repo_knowledge.domain_id -> code_domains (no cascade -- migration 017:6)
-- repo_knowledge must be dropped BEFORE code_domains.

DROP TABLE IF EXISTS ai_comment_feedback;
DROP TABLE IF EXISTS ai_review_feedback;
DROP TABLE IF EXISTS ai_review_lessons;
DROP TABLE IF EXISTS pr_analysis_results;

DROP TABLE IF EXISTS repo_knowledge;

DROP TABLE IF EXISTS rule_feedback;
DROP TABLE IF EXISTS rule_matchers;
DROP TABLE IF EXISTS code_rules;
DROP TABLE IF EXISTS domain_file_mappings;
DROP TABLE IF EXISTS code_domains;
