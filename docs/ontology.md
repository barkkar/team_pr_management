# Ontology & 3-pass review

This repo has a deterministic rule system for Pass 2 of the AI code review, backed by a hierarchical domain taxonomy. LLM classification is the fallback when deterministic matching finds nothing.

## Why this exists

Pure vector-similarity RAG drifts — the same file looks "similar" to unrelated reviews, and rule enforcement becomes probabilistic. This system replaces vector retrieval for rule context with a deterministic, inspectable graph that:

- Maps files to **domains** via glob patterns.
- Maps code patterns and annotations to **rules** directly.
- Inherits rules up the domain tree via recursive CTE.
- Falls back to Claude when a file doesn't match any domain's glob pattern.

## Data model

See `docs/database.md` for full schema; here's the shape.

```
code_domains (self-referential via parent_id)
  └─ code_rules (domain_id → code_domains)
        └─ rule_matchers (rule_id, matcher_type, pattern, is_regex, priority)
domain_file_mappings (domain_id, file_pattern glob, priority)
rule_feedback (append-only; rule_id + pr_url + user_id + action)
```

Initial tables created in migration 015; seeded from `core-dev-claude-skills` in 016; `repo_knowledge` was extended with `domain_id`/`code_element_type`/`code_element_name` in 017.

`matcher_type` enum (enforced in code, not by CHECK constraint):
- `file_path` — glob pattern against changed file paths (minimatch, `dot: true, nocase: true`).
- `code_pattern` — regex or case-insensitive substring against the diff text. Yields at most one match per rule.
- `annotation` — word-boundary regex against the diff text.

`severity` is sorted critical → high → medium → low (`src/services/ontologyEngine.ts:375`).

## Resolution algorithm

`resolveRulesForPR(changedFiles, diffText)` in `src/services/ontologyEngine.ts:304`:

1. **File paths → domains** via `domain_file_mappings`. For each matched `(filePath, domainId)`, collect `domainId`s.
2. **Domain → rules** via `getRulesForDomains(domainIds)` — a recursive CTE walks `parent_id` upward so ancestor rules apply too.
3. **File paths → rules** via `rule_matchers` where `matcher_type='file_path'`.
4. **Diff text → rules** via `matchCodePatterns(diffText)` — both `code_pattern` and `annotation` matchers. `code_pattern` yields at most one match per rule.
5. Merge + dedupe by `rule.id`. Annotate each rule with `match_detail` (human-readable) and return sorted by severity.

## LLM classifier fallback

When the HTTP endpoint `/api/resolve-rules` returns a non-empty `unmatched_files` list, `worker/prAnalyzer.ts` calls `classifyUnmatchedFiles` from `src/services/ruleClassifier.ts`. For each file:

1. Claude is given the taxonomy + file path + diff (truncated to 4K chars).
2. Claude returns an array of domain IDs it thinks apply (accepts `[...]`, `{domains:[...]}`, or `{domain_ids:[...]}`).
3. IDs are validated against the loaded taxonomy.
4. `getRulesForDomains` fetches rules for the approved IDs.
5. `classifyUnmatchedFiles` dedupes rules across files and returns a `ResolvedRule[]`.

Claude call parameters: `temperature=0.1, maxTokens=100, jsonMode=true`.

## 3-pass review

The full AI review (`worker/prAnalyzer.ts` and `worker/testReview.ts`) runs three Claude passes per PR:

1. **Pass 1 — Implementation**: PR diff + top-K similar past reviews (vector) + domain-scoped code examples + recent feedback + learning context. Focuses on bugs, logic errors, unintended regressions.
2. **Pass 2 — Rule compliance**: PR diff + resolved rules (deterministic + LLM classifier). Each rule becomes a check item; Claude returns `file_path`/`line_hint`/`severity` per finding.
3. **Pass 3 — Test coverage**: PR diff + test-file subset. Emits missing-test and low-coverage suggestions.

All three pass outputs are merged and deduplicated, then shipped to Heroku via `POST /api/pr-analysis` (see `docs/api-endpoints.md`), which stores into `pr_analysis_results` and posts a Slack thread reply via `formatSlackAnalysis`.

## Rule authoring

Use the HTTP API (see `docs/api-endpoints.md`). Example creating a rule with matchers + file mappings in one call:

```bash
curl -X POST "$HEROKU_API_URL/api/ontology/rules" \
  -H "X-Worker-API-Key: $WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "domain_id": 1,
    "rule_key": "entity.field.must_have_help_text",
    "title": "Entity fields must have help text",
    "description": "All custom entity fields must include a help text description.",
    "severity": "high",
    "matchers": [
      {"matcher_type": "code_pattern", "pattern": "CustomField", "is_regex": false}
    ],
    "file_mappings": [
      {"file_pattern": "src/entities/**/*.ts", "priority": 10}
    ]
  }'
```

`rule_key` must be unique. Update with `PUT /api/ontology/rules/:id`; delete cascades to matchers.

## Feedback signal

- **Overall review**: 👍/👎 in Slack → `ai_review_feedback` (one row per user per PR).
- **Per comment**: 👍/👎 on each suggestion → `ai_comment_feedback`.
- **Per rule**: `POST /api/ontology/rule-feedback` (no UI yet — invoked manually). Captures `action` (typically "override" or "dismiss") so future iterations can down-weight noisy rules.

These signals feed back into Pass 1 via `/api/ai-learning-context` (recent feedback with text) and `/api/ai-learning-context` lessons (synthesized post-close by `reviewLearner`/`bootstrapLearner`).

## Pointers

- `src/services/ontologyEngine.ts` — core resolution + CRUD.
- `src/services/ruleClassifier.ts` — Claude-backed fallback.
- `src/services/codeContextProvider.ts` — domain-scoped code examples for Pass 1 / Pass 2.
- `worker/prAnalyzer.ts` — orchestrates the full 3-pass flow for a single PR.
- `worker/testReview.ts` — same pipeline, dry-run with heavy logging. Use before committing ontology changes.
- Migrations 015 / 016 / 017.
