# Database

Postgres (Heroku-managed). The `vector` extension is still enabled (migration 007) but no vector columns remain after migration 018. Single connection pool at `src/db/client.ts:4-7` — uses `ssl: { rejectUnauthorized: false }` when `NODE_ENV=production`, otherwise SSL is disabled.

## Migrations

`src/db/migrate.ts` runs every `.sql` file in `src/db/migrations/` in alphabetical order. Applied files are tracked in `schema_migrations(filename PRIMARY KEY, applied_at)` (`src/db/migrate.ts:10-15`). On failure it exits with code 1 (no transaction wrapping across files). 

**Upgrade seeding quirk**: if `schema_migrations` is empty but `tracked_prs` already exists, migrations 001–006 are inserted as pre-applied to avoid re-running them on an older DB (`src/db/migrate.ts:20-47`). Migrations 007–021 always apply based on the tracking table alone.

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

### `pr_reviews` (removed)

Removed in migration 024.

### `pr_files` (removed)

Removed in migration 024.

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

### `harvest_state` (removed)

Removed in migration 024.

### `channel_bootstrap_members` (021)

Slack-channel onboarding queue that feeds the VPN worker's bootstrap drain (see `worker/channelBootstrap.ts`). Enqueued by `src/services/channelBootstrap.ts` on `/pr-monitor add` and by the `member_joined_channel` handler in `src/app.ts:374-397`.

Columns: `id SERIAL PK`, `channel_id TEXT NOT NULL`, `slack_user_id TEXT NOT NULL`, `email TEXT NOT NULL`, `status TEXT NOT NULL DEFAULT 'pending'` (values observed in code: `pending`, `in_progress`, `resolved`, `unresolved`, `aged_out`), `attempts INT NOT NULL DEFAULT 0`, `last_error TEXT`, `claimed_at TIMESTAMP`, `enqueued_at TIMESTAMP NOT NULL DEFAULT NOW()`, `resolved_at TIMESTAMP`. `UNIQUE (channel_id, slack_user_id)`. Index `idx_cbm_status_enqueued ON (status, enqueued_at)`.

### `team_documents` (removed)

Removed in migration 018.

## `src/db/client.ts` API (consolidated)

See `src/db/client.ts` for signatures; this is a map of what touches which table. All exports return plain objects — no ORM layer.

### PR tracking
- `insertTrackedPR(pr)` — `INSERT tracked_prs ON CONFLICT (pr_url) DO NOTHING RETURNING *`. (`client.ts:44`)
- `getPendingReminders()` — `reminder_sent=FALSE AND is_open≠FALSE AND eligible_reminder_at ≤ NOW()`. (`client.ts:66`)
- `markReminderSent(id)` / `scheduleNextReminder(id, nextAt?)` — the latter keeps `reminder_sent=FALSE` and bumps `reminder_count`. (`client.ts:78, 87`)
- `getOpenUnreviewedPRs()` — `is_open IN (TRUE, NULL)` AND `has_reviews IN (FALSE, NULL)`, ordered by `posted_at ASC`. (`client.ts:105`)
- `markPRClosed(id)` / `getTrackedPRByUrl(prUrl)` — (`client.ts:116, 120`).
- `getPRsNeedingStatusCheck()` / `updatePRStatus(prUrl, isOpen, hasReviews)` — status-check picks PRs never checked or stale > 5 min, `LIMIT 50`. (`client.ts:133, 148`)
- `getDistinctRepos()` — powers `/api/distinct-repos`. (`client.ts:458`)
- `getReviewStats()` — summary for `/pr-monitor stats` (breakdown by `reminder_count` bucket). (`client.ts:219`)

### Monitored channels
- `addMonitoredChannel`, `removeMonitoredChannel`, `getMonitoredChannels`, `isChannelMonitored`. (`client.ts:164, 178, 189, 199`)

### User mappings + channel members
- `upsertUserMapping`, `getUserMapping`, `getAllUserMappings` — `upsertUserMapping` accepts an optional `client: Pool | PoolClient` parameter so it can participate in the bootstrap transaction.
- `getChannelMembers(channelId)` — joins `channel_bootstrap_members` × `user_mappings` on `slack_user_id`, restricted to `status='resolved'`. Returns `{ ghe_login, slack_user_id, display_name, email }[]` for the resolved members of the channel. Consumed by `/api/channel-members`.

### Channel bootstrap queue
- `insertBootstrapMembers(rows)` — bulk `INSERT ... ON CONFLICT (channel_id, slack_user_id) DO NOTHING` into `channel_bootstrap_members`; returns the count of freshly inserted rows. Called by `enqueueChannelBootstrap` and the `member_joined_channel` handler in `src/app.ts`. (`client.ts:470`)
- `claimPendingBootstrap(limit)` — atomically claims up to `limit` rows whose status is `pending` and `attempts < 3`, or `in_progress` with a stale (>15 min) `claimed_at`, using `SELECT ... FOR UPDATE SKIP LOCKED`. Sets status to `in_progress` and `claimed_at = NOW()` and returns `{ id, channel_id, slack_user_id, email }[]`. Used by `/api/bootstrap-claim`. (`client.ts:499`)
- `updateBootstrapResults(results)` — transactional batch apply: `resolved` rows are marked resolved and the mapping is upserted into `user_mappings` with `discovered_via='bootstrap_search'`; `unresolved` rows are marked unresolved; `pending` rows increment `attempts`, clear `claimed_at`, and age out to `aged_out` once `attempts >= 3`. Used by `/api/bootstrap-complete`. (`client.ts:525`)

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

-- Who's been resolved as a member of channel C0123?
SELECT um.ghe_login, um.slack_user_id, um.display_name, um.email
FROM channel_bootstrap_members cbm
JOIN user_mappings um ON um.slack_user_id = cbm.slack_user_id
WHERE cbm.channel_id = 'C0123' AND cbm.status = 'resolved';

```
