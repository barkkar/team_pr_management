# Database

Postgres (Heroku-managed). The `vector` extension is still enabled (migration 007) but no vector columns remain after migration 018. Single connection pool at `src/db/client.ts:3-6` — uses `ssl: { rejectUnauthorized: false }` when `NODE_ENV=production`, otherwise SSL is disabled.

## Migrations

`src/db/migrate.ts` runs every `.sql` file in `src/db/migrations/` in alphabetical order. Applied files are tracked in `schema_migrations(filename PRIMARY KEY, applied_at)` (`src/db/migrate.ts:10-15`). On failure it exits with code 1 (no transaction wrapping across files). 

**Upgrade seeding quirk**: if `schema_migrations` is empty but `tracked_prs` already exists, migrations 001–006 are inserted as pre-applied to avoid re-running them on an older DB (`src/db/migrate.ts:21-47`).

To run: `npm run migrate` locally, or rely on the Heroku `release` process (`Procfile`).

## Table catalog (merged view)

### `tracked_prs` — core PR state (001, 003, 005, 006)

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `pr_url` | TEXT NOT NULL UNIQUE | Full URL, used as logical key across tables |
| `org` | TEXT NOT NULL | |
| `repo` | TEXT NOT NULL | |
| `pr_number` | INT NOT NULL | |
| `channel_id` | TEXT NOT NULL | Slack channel |
| `message_ts` | TEXT NOT NULL | Slack ts of original post — used as `thread_ts` |
| `posted_at` | TIMESTAMP NOT NULL | |
| `eligible_reminder_at` | TIMESTAMP NOT NULL | Business-hours-aware |
| `reminder_sent` | BOOL DEFAULT FALSE | Note: toggled by `markReminderSent`; `scheduleNextReminder` keeps it FALSE so the PR stays in the queue |
| `has_reviews` | BOOL DEFAULT FALSE | Worker-reported |
| `is_open` | BOOL DEFAULT TRUE | Worker-reported |
| `status_checked_at` | TIMESTAMP | Worker-reported; reminders require freshness ≤10 min |
| `reminder_count` | INT DEFAULT 0 | |
| `created_at` | TIMESTAMP DEFAULT NOW() | |

Indexes: `idx_tracked_prs_url`, `idx_tracked_prs_pending`, `idx_tracked_prs_status_check`.

### `channel_poll_state` (002)

`channel_id TEXT PK`, `last_poll_ts TEXT NOT NULL`, `updated_at TIMESTAMP DEFAULT NOW()`. Used by `channelPoller` to resume per-channel cursors.

### `monitored_channels` (004)

`id SERIAL PK`, `channel_id VARCHAR(20) UNIQUE NOT NULL`, `channel_name VARCHAR(100)`, `added_by VARCHAR(20) NOT NULL`, `added_at TIMESTAMP DEFAULT NOW()`, `enabled BOOL DEFAULT TRUE`. Populated by `/pr-monitor add|remove`.

### `pr_reviews` (008)

Inline review comments pulled from GHE. Keys: `pr_url`, `reviewer_login`, `file_path`, `diff_hunk`, `comment_body`, `review_state`, `submitted_at`. Indexed on `repo`, `reviewer`, `file`.

### `pr_files` (008)

Changed files per PR. Columns include `file_path`, `change_type`, `additions`, `deletions`, `patch_snippet`, `author_login`. Indexed on `repo`, `file`, `author`.

### `pr_embeddings`

Removed in migration 018.

### `user_mappings` (008)

`ghe_login UNIQUE`, `slack_user_id`, `display_name`, `email`, `discovered_via` ('email'|'name'|'manual'). Indexed on `slack_user_id`.

### `repo_knowledge` (008, extended by 017)

Chunked source code for RAG.

| Column | Type | Notes |
|---|---|---|
| `id` | SERIAL PK | |
| `org`, `repo`, `file_path` | TEXT | Natural key with `chunk_index` |
| `content_chunk` | TEXT | ~1500 chars |
| `chunk_index` | INT | |
| `last_commit_sha` | TEXT | |
| `domain_id` | INT FK → `code_domains` | Added in 017 |
| `code_element_type` | TEXT CHECK IN ('class','function','interface','test','config','unknown') | Added in 017 |
| `code_element_name` | TEXT | Added in 017 |
| `created_at`, `updated_at` | TIMESTAMP | |

Indexes: repo, file, domain, element, domain+element composite.

Natural key: `(org, repo, file_path, chunk_index)` — `upsertRepoKnowledge` does `ON CONFLICT ... DO UPDATE` on that combo.

### `harvest_state` (008)

`(org, repo) UNIQUE`, `last_harvested_pr_number`, `last_repo_harvest_sha`, `last_harvested_at`, `last_repo_harvested_at`. Updated by both `prHarvester` and `repoHarvester`.

### `pr_analysis_results` (009)

`pr_url UNIQUE`, `channel_id`, `message_ts`, `review_json JSONB`, `reviewers_json JSONB`. Upserted from `POST /api/pr-analysis`. `/api/repost-analysis` reads from here.

### `ai_review_feedback` (010)

UNIQUE(`pr_url`, `user_id`). `rating` CHECK IN ('helpful', 'not_helpful'). Optional `feedback_text`. Written from the overall 👍/👎 + modal.

### `ai_review_lessons` (011, extended by 012)

`pr_url UNIQUE`, `ai_review_json`, `peer_comments_json`, `lessons_json`. Consumed by `/api/ai-learning-context`.

### `team_documents`

Removed in migration 018.

### `ai_comment_feedback` (014)

UNIQUE(`pr_url`, `comment_index`, `user_id`). Optional `comment_snapshot JSONB` for the comment body at time of feedback.

### Ontology tables (015, seed 016, extended by 017)

- `code_domains` — hierarchical domains (`parent_id` self-FK). `name UNIQUE`, `display_name`, `description`.
- `code_rules` — belongs to a domain. `rule_key UNIQUE`, `title`, `description`, `severity DEFAULT 'high'`, `enabled`, `team_owner`.
- `rule_matchers` — `matcher_type TEXT NOT NULL` (one of 'file_path' | 'code_pattern' | 'annotation' — enforced in code, not by constraint), `pattern`, `is_regex`, `priority`. `ON DELETE CASCADE` from `code_rules`.
- `domain_file_mappings` — glob pattern → domain, with `priority`. `ON DELETE CASCADE` from `code_domains`.
- `rule_feedback` — `rule_id`, `pr_url`, `user_id`, `action`, optional `feedback_text`. No uniqueness — one row per feedback event.

Migration 016 seeds an initial taxonomy from `core-dev-claude-skills` skill routing data (domains + rules + matchers + file mappings).

## `src/db/client.ts` API (consolidated)

See `src/db/client.ts` for signatures; this is a map of what touches which table. All exports return plain objects — no ORM layer.

### PR tracking
- `insertTrackedPR(pr)` — `INSERT tracked_prs ON CONFLICT (pr_url) DO NOTHING RETURNING *`. (`client.ts:42`)
- `getPendingReminders()` — `reminder_sent=FALSE AND is_open≠FALSE AND eligible_reminder_at ≤ NOW()`. (`client.ts:64`)
- `markReminderSent(id)` / `scheduleNextReminder(id, nextAt?)` — the latter keeps `reminder_sent=FALSE` and bumps `reminder_count`. (`client.ts:76, 85`)
- `getOpenUnreviewedPRs()` — `is_open IN (TRUE, NULL)` AND `has_reviews IN (FALSE, NULL)`, ordered by `posted_at ASC`. (`client.ts:103`)
- `markPRClosed(id)` / `getTrackedPRByUrl(prUrl)` / `updatePRStatus(prUrl, isOpen, hasReviews)` / `getPRsNeedingStatusCheck()` — status-check picks PRs never checked or stale > 5 min, `LIMIT 50`. (`client.ts:114, 118, 131, 146`)
- `getDistinctRepos()` — powers `/api/distinct-repos`. (`client.ts:587`)
- `getReviewStats()` — summary for `/pr-monitor stats` (breakdown by `reminder_count` bucket). (`client.ts:217`)

### Monitored channels
- `addMonitoredChannel`, `removeMonitoredChannel`, `getMonitoredChannels`, `isChannelMonitored`. (`client.ts:162, 176, 187, 197`)

### Harvest + knowledge
- `insertPRReview`, `getPRReviewCount`, `insertPRFile`. (`client.ts:360, 374, 381`)
- `upsertUserMapping`, `getUserMapping`, `getAllUserMappings`. (`client.ts:397, 416, 421`)
- `getHarvestState`, `upsertHarvestState`, `upsertRepoHarvestState`. (`client.ts:428, 433, 443`)
- `upsertRepoKnowledge(chunk)` — upserts on `(org, repo, file_path, chunk_index)`, also stores `domain_id` + `code_element_type` + `code_element_name`. (`client.ts:455`)
- `deleteRepoKnowledgeForFile(org, repo, filePath)`. (`client.ts:482`)
- `findReviewersByFiles(filePaths, topK=10)` / `findCodeTouchersByFiles(filePaths, topK=10)` — aggregate over `pr_reviews`/`pr_files`, match exact path or `LIKE` dir prefix, excluding NULL authors for touchers. (`client.ts:552, 570`)

### AI feedback + lessons
- `insertOrUpdateFeedback(prUrl, userId, rating, feedbackText?)` / `getRecentFeedback(limit=5)`. (`client.ts:596, 607`)
- `insertOrUpdateCommentFeedback(prUrl, commentIndex, userId, rating, commentSnapshot?)` / `getCommentFeedbackStats(prUrl)`. (`client.ts:623, 634`)
- `insertReviewLessons(prUrl, aiReview, peerComments, lessons)` — 4-arg signature. (`client.ts:651`)
- `getRecentLessons(limit=3)` / `getPRsNeedingLessonExtraction()` — last one joins `pr_analysis_results`, `tracked_prs`, `ai_review_lessons` to find closed PRs that have an AI review stored but no lessons yet (LIMIT 20). (`client.ts:672, 682, 695`)

### Re-exports
`fetchDomainScopedCodeExamples`, `formatCodeExamplesForPrompt` re-exported from `../services/codeContextProvider` for consumers that import only from `client.ts`. (`client.ts:779`)

## pgvector patterns

pgvector is no longer used in application code; see migration 018.

## Debug SQL cheats

```sql
-- What's pending and why?
SELECT pr_url, posted_at, eligible_reminder_at, has_reviews, is_open,
       status_checked_at, reminder_count
FROM tracked_prs
WHERE reminder_sent = FALSE
ORDER BY eligible_reminder_at;

-- Who gets suggested reviewer for file X?
SELECT reviewer_login, COUNT(*)
FROM pr_reviews WHERE file_path = 'src/foo.ts' GROUP BY 1 ORDER BY 2 DESC;

-- Ontology tree with rule counts
SELECT d.name, d.parent_id, COUNT(r.id)
FROM code_domains d LEFT JOIN code_rules r ON r.domain_id = d.id
GROUP BY d.id ORDER BY d.parent_id NULLS FIRST, d.name;
```
