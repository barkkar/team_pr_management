-- Seed ontology tables from existing SKILL_ROUTING keyword patterns
-- This migrates the hardcoded regex arrays into the deterministic ontology

-- Root domain
INSERT INTO code_domains (name, display_name, parent_id, description)
VALUES ('core-engineering', 'Core Engineering', NULL, 'Root domain for all core engineering coding rules')
ON CONFLICT (name) DO NOTHING;

-- Child domains (from SKILL_ROUTING areas)
INSERT INTO code_domains (name, display_name, parent_id, description)
VALUES
  ('entity', 'Entity/UDD', (SELECT id FROM code_domains WHERE name = 'core-engineering'), 'Entity definitions, UDD objects, fields, SOQL, custom objects'),
  ('database', 'Database', (SELECT id FROM code_domains WHERE name = 'core-engineering'), 'SDB, SFSQL, PLSQL, stored procedures, database migrations'),
  ('testing', 'Testing', (SELECT id FROM code_domains WHERE name = 'core-engineering'), 'Functional tests, entity enablers, CRUD tests'),
  ('infrastructure', 'Infrastructure', (SELECT id FROM code_domains WHERE name = 'core-engineering'), 'Bazel, build systems, app server, graph tool'),
  ('async', 'Async/Scheduled', (SELECT id FROM code_domains WHERE name = 'core-engineering'), 'Message queues, async handlers, background processing, cron jobs'),
  ('permissions', 'Permissions', (SELECT id FROM code_domains WHERE name = 'core-engineering'), 'Org/user permissions, feature flags, pilot gates, license checks'),
  ('logging', 'Logging', (SELECT id FROM code_domains WHERE name = 'core-engineering'), 'Structured logging, LogRecordType, app logging format'),
  ('modules', 'Modules', (SELECT id FROM code_domains WHERE name = 'core-engineering'), 'Spring configuration, dependency injection, module descriptors'),
  ('git', 'Git', (SELECT id FROM code_domains WHERE name = 'core-engineering'), 'Git commits, PRs, P4 submits, code check-in')
ON CONFLICT (name) DO NOTHING;

-- Domain file mappings (common file path patterns per domain)
INSERT INTO domain_file_mappings (domain_id, file_pattern, priority) VALUES
  ((SELECT id FROM code_domains WHERE name = 'entity'), '**/entity/**', 10),
  ((SELECT id FROM code_domains WHERE name = 'entity'), '**/*Entity*.java', 5),
  ((SELECT id FROM code_domains WHERE name = 'entity'), '**/*.object-meta.xml', 8),
  ((SELECT id FROM code_domains WHERE name = 'entity'), '**/*.field-meta.xml', 8),
  ((SELECT id FROM code_domains WHERE name = 'database'), '**/*.sql', 10),
  ((SELECT id FROM code_domains WHERE name = 'database'), '**/db/**', 8),
  ((SELECT id FROM code_domains WHERE name = 'database'), '**/migration*/**', 7),
  ((SELECT id FROM code_domains WHERE name = 'testing'), '**/*Test*.java', 10),
  ((SELECT id FROM code_domains WHERE name = 'testing'), '**/__tests__/**', 10),
  ((SELECT id FROM code_domains WHERE name = 'testing'), '**/*.test.*', 10),
  ((SELECT id FROM code_domains WHERE name = 'infrastructure'), '**/BUILD.bazel', 10),
  ((SELECT id FROM code_domains WHERE name = 'infrastructure'), '**/BUILD', 8),
  ((SELECT id FROM code_domains WHERE name = 'infrastructure'), '**/.bazelrc', 5),
  ((SELECT id FROM code_domains WHERE name = 'async'), '**/queue/**', 8),
  ((SELECT id FROM code_domains WHERE name = 'async'), '**/job/**', 7),
  ((SELECT id FROM code_domains WHERE name = 'async'), '**/*Job*.java', 6),
  ((SELECT id FROM code_domains WHERE name = 'permissions'), '**/permission*/**', 8),
  ((SELECT id FROM code_domains WHERE name = 'permissions'), '**/access*/**', 7),
  ((SELECT id FROM code_domains WHERE name = 'logging'), '**/logging/**', 8),
  ((SELECT id FROM code_domains WHERE name = 'logging'), '**/log/**', 7),
  ((SELECT id FROM code_domains WHERE name = 'modules'), '**/*Configuration*.java', 8),
  ((SELECT id FROM code_domains WHERE name = 'modules'), '**/module-descriptor*', 7);

-- Seed rules from SKILL_ROUTING keyword patterns (one rule per domain for keyword matching)
-- Entity/UDD rules
INSERT INTO code_rules (domain_id, rule_key, title, description, severity, team_owner)
VALUES (
  (SELECT id FROM code_domains WHERE name = 'entity'),
  'entity.keyword_match',
  'Entity/UDD Code Patterns',
  'Code changes involving Entity definitions (UDD, EntityObject, EntityFunctions, EntityDef, EntityRecord, SOQL, CustomObject, CustomField, StandardEntity) must follow entity engineering guidelines. Ensure proper field labels, shared labels, and object definitions are correctly structured.',
  'high',
  'core-engineer/entity-engineer'
) ON CONFLICT (rule_key) DO NOTHING;

INSERT INTO code_rules (domain_id, rule_key, title, description, severity, team_owner)
VALUES (
  (SELECT id FROM code_domains WHERE name = 'database'),
  'database.keyword_match',
  'Database Code Patterns',
  'Code changes involving database operations (SDB, SFSQL, PLSQL, stored procedures, database migrations, SQL files) must follow database engineering guidelines. Ensure proper schema updates, migration safety, and query optimization.',
  'high',
  'core-engineer/db-engineer'
) ON CONFLICT (rule_key) DO NOTHING;

INSERT INTO code_rules (domain_id, rule_key, title, description, severity, team_owner)
VALUES (
  (SELECT id FROM code_domains WHERE name = 'testing'),
  'testing.keyword_match',
  'Test Code Patterns',
  'Code changes involving tests (ftest, functional tests, EntityEnabler, PublicEntityTest, CRUD tests) must follow test engineering guidelines. Ensure proper test coverage, entity enabler registration, and test suite configuration.',
  'high',
  'core-engineer/test-engineer'
) ON CONFLICT (rule_key) DO NOTHING;

INSERT INTO code_rules (domain_id, rule_key, title, description, severity, team_owner)
VALUES (
  (SELECT id FROM code_domains WHERE name = 'infrastructure'),
  'infra.keyword_match',
  'Infrastructure Code Patterns',
  'Code changes involving infrastructure (Bazel, buildifier, BUILD.bazel, db schema updates, app server, graph tool) must follow infrastructure engineering guidelines. Ensure proper build targets, dependency declarations, and server configurations.',
  'high',
  'core-engineer/infra-engineer'
) ON CONFLICT (rule_key) DO NOTHING;

INSERT INTO code_rules (domain_id, rule_key, title, description, severity, team_owner)
VALUES (
  (SELECT id FROM code_domains WHERE name = 'async'),
  'async.keyword_match',
  'Async/Scheduled Code Patterns',
  'Code changes involving async processing (message queues, MQ handlers, async handlers, background processing, cron jobs, scheduled tasks, QueueableJob, BatchableJob) must follow async engineering guidelines. Ensure proper error handling, retry logic, and idempotency.',
  'high',
  'core-engineer/async-engineer'
) ON CONFLICT (rule_key) DO NOTHING;

INSERT INTO code_rules (domain_id, rule_key, title, description, severity, team_owner)
VALUES (
  (SELECT id FROM code_domains WHERE name = 'permissions'),
  'permissions.keyword_match',
  'Permission Code Patterns',
  'Code changes involving permissions (org permissions, user permissions, feature flags, pilot gates, license checks, SKU, access control, PLD) must follow permission engineering guidelines. Ensure proper authorization checks and feature gating.',
  'critical',
  'core-engineer/permission-engineer'
) ON CONFLICT (rule_key) DO NOTHING;

INSERT INTO code_rules (domain_id, rule_key, title, description, severity, team_owner)
VALUES (
  (SELECT id FROM code_domains WHERE name = 'logging'),
  'logging.keyword_match',
  'Logging Code Patterns',
  'Code changes involving logging (LogRecordType, structured logging, app logging format) must follow logging engineering guidelines. Ensure proper log record types and structured logging format.',
  'medium',
  'core-engineer/logrecord-engineer'
) ON CONFLICT (rule_key) DO NOTHING;

INSERT INTO code_rules (domain_id, rule_key, title, description, severity, team_owner)
VALUES (
  (SELECT id FROM code_domains WHERE name = 'modules'),
  'modules.keyword_match',
  'Module Configuration Patterns',
  'Code changes involving module configuration (SpringConfiguration, @Configuration, @Bean, @Import, dependency injection, API_Impl, module descriptors) must follow module engineering guidelines. Ensure proper dependency injection and module descriptor registration.',
  'high',
  'core-engineer/module-engineer'
) ON CONFLICT (rule_key) DO NOTHING;

INSERT INTO code_rules (domain_id, rule_key, title, description, severity, team_owner)
VALUES (
  (SELECT id FROM code_domains WHERE name = 'git'),
  'git.keyword_match',
  'Git/SCM Code Patterns',
  'Code changes involving source control operations (git commit, git push, create PR, P4 submit, check-in code, submit for review) must follow git engineering guidelines. Ensure proper commit messages and review workflows.',
  'medium',
  'core-engineer/git-engineer'
) ON CONFLICT (rule_key) DO NOTHING;

-- Seed rule_matchers from SKILL_ROUTING regex patterns (code_pattern type)
INSERT INTO rule_matchers (rule_id, matcher_type, pattern, is_regex, priority) VALUES
  ((SELECT id FROM code_rules WHERE rule_key = 'entity.keyword_match'), 'code_pattern', '\b(UDD|EntityObject|EntityFunctions|EntityDef|EntityRecord|SOQL|entity[.\-_]xml|object[.\-_]definition|field[.\-_]label|shared[.\-_]labels|CustomObject|CustomField|StandardEntity)\b', TRUE, 10),
  ((SELECT id FROM code_rules WHERE rule_key = 'database.keyword_match'), 'code_pattern', '\b(SDB|SFSQL|PLSQL|psql|db[.\-_]schema|stored[.\-_]procedure|database[.\-_]migration|\.sql)\b', TRUE, 10),
  ((SELECT id FROM code_rules WHERE rule_key = 'testing.keyword_match'), 'code_pattern', '\b(ftest|functional[.\-_]test|EntityEnabler|PublicEntityTest|AccessBasedEntityEnablerList|OldTestSuiteEntityAllowList|CRUD[.\-_]test)\b', TRUE, 10),
  ((SELECT id FROM code_rules WHERE rule_key = 'infra.keyword_match'), 'code_pattern', '\b(bazel|buildifier|BUILD\.bazel|db[.\-_]schema[.\-_]update|app[.\-_]server|graph[.\-_]tool)\b', TRUE, 10),
  ((SELECT id FROM code_rules WHERE rule_key = 'async.keyword_match'), 'code_pattern', '\b(message[.\-_]queue|MQ[.\-_]handler|async[.\-_]handler|background[.\-_]processing|cron[.\-_]job|scheduled[.\-_]task|QueueableJob|BatchableJob)\b', TRUE, 10),
  ((SELECT id FROM code_rules WHERE rule_key = 'permissions.keyword_match'), 'code_pattern', '\b(org[.\-_]permission|user[.\-_]permission|feature[.\-_]flag|pilot[.\-_]gate|license[.\-_]check|SKU|access[.\-_]control|PLD)\b', TRUE, 10),
  ((SELECT id FROM code_rules WHERE rule_key = 'logging.keyword_match'), 'code_pattern', '\b(LogRecordType|structured[.\-_]logging|app[.\-_]logging[.\-_]format)\b', TRUE, 10),
  ((SELECT id FROM code_rules WHERE rule_key = 'modules.keyword_match'), 'code_pattern', '\b(SpringConfiguration|@Configuration|@Bean|@Import|dependency[.\-_]injection|API[.\-_]Impl|module[.\-_]descriptor)\b', TRUE, 10),
  ((SELECT id FROM code_rules WHERE rule_key = 'git.keyword_match'), 'code_pattern', '\b(git[.\-_]commit|git[.\-_]push|create[.\-_]PR|p4[.\-_]submit|check[.\-_]in[.\-_]code|submit[.\-_]for[.\-_]review)\b', TRUE, 10);
