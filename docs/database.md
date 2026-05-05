# Database

Postgres (Heroku-managed). The `vector` extension is still enabled (migration 007) but no vector columns remain after migration 018. Single connection pool at `src/db/client.ts:3-6` — uses `ssl: { rejectUnauthorized: false }` when `NODE_ENV=production`, otherwise SSL is disabled.

## Migrations

`src/db/migrate.ts` runs every `.sql` file in `src/db/migrations/` in alphabetical order. Applied files are tracked in `schema_migrations(filename PRIMARY KEY, applied_at)` (`src/db/migrate.ts:10-15`). On failure it exits with code 1 (no transaction wrapping across files). 

**Upgrade seeding quirk**: if `schema_migrations` is empty but `tracked_prs` already exists, migrations 001–006 are inserted as pre-applied to avoid re-running them on an older DB (`src/db/migrate.ts:21-47`).

To run: `npm run migrate` locally, or rely on the Heroku `release` process (`Procfile`).

## Table catalog (merged view)

### `tracked_prs` — core PR state (001, 003, 005, 006, 020)

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
| `suggestions_sent` | BOOL DEFAULT FALSE | Added by migration 020; marks if reviewer suggestions posted |
| `created_at` | TIMESTAMP DEFAULT NOW() | |

Indexes (all partial, where noted):
- `idx_tracked_prs_url` ON `(pr_url)` — from migration 001.
- `idx_tracked_prs_pending` ON `(eligible_reminder_at)` WHERE `reminder_sent = FALSE AND (is_open = TRUE OR is_open IS NULL)` — from 006.
- `idx_tracked_prs_status_check` ON `(reminder_sent, status_checked_at)` WHERE `(is_open = TRUE OR is_open IS NULL)` — from 006.
- `idx_tracked_prs_suggestions_pending` ON `(suggestions_sent, created_at)` WHERE `suggestions_sent = FALSE` — from 020.

### `channel_poll_state` (002)

`channel_id TEXT PK`, `last_poll_ts TEXT NOT NULL`, `updated_at TIMESTAMP DEFAULT NOW()`. Used by `channelPoller` to resume per-channel cursors.

### `monitored_channels` (004)

`id SERIAL PK`, `channel_id VARCHAR(20) UNIQUE NOT NULL`, `channel_name VARCHAR(100)`, `added_by VARCHAR(20) NOT NULL`, `added_at TIMESTAMP DEFAULT NOW()`, `enabled BOOL DEFAULT TRUE`. Populated by `/pr-monitor add|remove`.

### `pr_reviews` (008)

Inline review comments pulled from GHE. Keys: `pr_url`, `reviewer_login`, `file_path`, `diff_hunk`, `comment_body`, `review_state`, `submitted_at`. Indexed on `repo`, `reviewer`, `file`.

### `pr_files` (008)

Changed files per PR. Columns include `file_path`, `change_type`, `additions`, `deletions`, `patch_snippet`, `author_login`. Indexed on `repo`, `file`, `author`.

### `pr_embeddings` (removed)

Removed in migration 018.

### `pr_analysis_results` (removed)

Removed in migration 019.

### `ai_review_feedback` (removed)

Removed in migration 019.

### `ai_review_lessons` (removed)

Removed in migration 019.

### `ai_comment_feedback` (removed)

Removed in migration 019.

### `repo_knowledge` (removed)

Removed in migration 019.

### `code_domains` (removed)

Removed in migration 019.

### `code_rules` (removed)

Removed in migration 019.

### `rule_matchers` (removed)

Removed in migration 019.

### `domain_file_mappings` (removed)

Removed in migration 019.

### `rule_feedback` (removed)

Removed in migration 019.

### `user_mappings` (008)

`ghe_login UNIQUE`, `slack_user_id`, `display_name`, `email`, `discovered_via` ('email'|'name'|'manual'). Indexed on `slack_user_id`.

### `harvest_state` (008)

`(org, repo) UNIQUE`, `last_harvested_pr_number`, `last_repo_harvest_sha`, `last_harvested_at`, `last_repo_harvested_at`. Updated by `prHarvester` (if still present).

### `team_documents` (removed)

Removed in migration 018.

## `src/db/client.ts` API (consolidated)

See `src/db/client.ts` for signatures; this is a map of what touches which table. All exports return plain objects — no ORM layer.

### PR tracking
- `insertTrackedPR(pr)` — `INSERT tracked_prs ON CONFLICT (pr_url) DO NOTHING RETURNING *`. (`client.ts:43`)
- `getPendingReminders()` — `reminder_sent=FALSE AND is_open≠FALSE AND eligible_reminder_at ≤ NOW()`. (`client.ts:65`)
- `markReminderSent(id)` / `scheduleNextReminder(id, nextAt?)` — the latter keeps `reminder_sent=FALSE` and bumps `reminder_count`. (`client.ts:77, 86`)
- `getOpenUnreviewedPRs()` — `is_open IN (TRUE, NULL)` AND `has_reviews IN (FALSE, NULL)`, ordered by `posted_at ASC`. (`client.ts:104`)
- `markPRClosed(id)` / `getTrackedPRByUrl(prUrl)` / `updatePRStatus(prUrl, isOpen, hasReviews)` / `getPRsNeedingStatusCheck()` — status-check picks PRs never checked or stale > 5 min, `LIMIT 50`. (`client.ts:115, 119, 132, 147`)
- `getDistinctRepos()` — powers `/api/distinct-repos`. (`client.ts:454`)
- `getReviewStats()` — summary for `/pr-monitor stats` (breakdown by `reminder_count` bucket). (`client.ts:218`)

### Monitored channels
- `addMonitoredChannel`, `removeMonitoredChannel`, `getMonitoredChannels`, `isChannelMonitored`. (`client.ts:163, 177, 188, 198`)

### Harvest + reviewer scoring
- `insertPRReview`, `getPRReviewCount`, `insertPRFile`. (`client.ts:330, 344, 351`)
- `upsertUserMapping`, `getUserMapping`, `getAllUserMappings`. (`client.ts:367, 386, 391`)
- `getHarvestState`, `upsertHarvestState`. (`client.ts:398, 403`)
- `findReviewersByFiles(filePaths, topK=10)` / `findCodeTouchersByFiles(filePaths, topK=10)` — aggregate over `pr_reviews`/`pr_files`, match exact path or `LIKE` dir prefix, excluding NULL authors for touchers. Consumed by `/api/past-reviewers`, `/api/past-authors`, and `/api/suggested-reviewers`. (`client.ts:419, 437`)

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

```
