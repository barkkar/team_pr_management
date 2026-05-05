# HTTP API endpoints

Every route is served by the single HTTP server created in `src/index.ts:142`. The server runs inside the Heroku dyno, alongside the Slack Bolt Socket Mode app.

**Auth**: all `/api/*` routes call `validateApiKey(req)` (`src/index.ts:33-43`), which reads the `X-Worker-API-Key` header or an `Authorization: Bearer <token>` fallback and compares to `WORKER_API_KEY`. `/health` and `/` are public (`src/index.ts:159-162`). If `WORKER_API_KEY` is unset, `validateApiKey` logs a warning and returns false, so every `/api/*` route returns 401.

**CORS**: wide-open `Access-Control-Allow-Origin: *` with `GET, POST, OPTIONS` and `Content-Type, X-Worker-API-Key, Authorization` header allowlist (`src/index.ts:147-149`).

**Error handling**: unhandled errors return 500 with `{ error }` and call `notifyError('HTTPServer', ...)`.

## Health

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Same as `/health` |
| GET | `/health` | Returns `{status: 'ok', app: 'pr-review-reminder'}` |

## Worker status sync

| Method | Path | Body / Query | Purpose |
|---|---|---|---|
| GET | `/api/pending-prs` | — | PRs needing a GHE status check. Used by `localPRChecker`. |
| POST | `/api/pr-status` | `{results: [{pr_url, is_open, has_reviews}]}` | Worker reports GHE check results. Updates `tracked_prs`. |

## Harvest — PR data

| Method | Path | Body / Query | Purpose |
|---|---|---|---|
| GET | `/api/tracked-prs-for-harvest` | — | Tracked PRs not yet in `pr_reviews`. Used by `prHarvester` incremental mode. |
| GET | `/api/all-tracked-prs` | — | Every tracked PR (for `HARVEST_ALL=1` re-harvest). |
| GET | `/api/distinct-repos` | — | Distinct `{org, repo, hostname}` from `tracked_prs`. `hostname` is not a DB column — it's inferred at query time by regex-matching each PR URL against `*.soma.salesforce.com`. |
| GET | `/api/harvest-state?org=...&repo=...` | — | Returns `{state}` for `harvest_state`. |
| POST | `/api/harvest-data` | `{reviews[], files[], harvest_state?}` | Uploads review comments + file rows. |
| POST | `/api/user-mappings` | `{mappings[]}` | `userMapper` upserts GHE↔Slack mappings. |

## Reviewer Suggestions

| Method | Path | Body / Query | Purpose |
|---|---|---|---|
| POST | `/api/past-reviewers` | `{file_paths[], pr_author?, top_k?}` (default 10, max 20) | Returns `{reviewers: [{ghe_login, review_count, files[]}]}` — past reviewers of the given files (exact path or same directory). Excludes `pr_author`. Called by Claude via the `get_past_reviewers` tool in the worker's tool-loop. |
| POST | `/api/past-authors` | `{file_paths[], pr_author?, top_k?}` (default 10, max 20) | Returns `{authors: [{ghe_login, change_count, files[]}]}`. Excludes `pr_author`. Called by Claude via the `get_past_authors` tool. |
| GET | `/api/prs-needing-reviewer-suggestions` | — | Tracked PRs from last 24h with `suggestions_sent=FALSE`. LIMIT 10. |
| POST | `/api/pr-reviewers` | `{pr_url, channel_id, message_ts, suggestions: [{ghe_login, reason}]}` | Worker submits final reviewer list. Server resolves Slack IDs via `user_mappings`, sets `tracked_prs.suggestions_sent=TRUE`, and posts a threaded Slack reply when `channel_id !== 'manual'` AND `message_ts !== '0'` (CLI one-shots with `-- <pr-url>` use those sentinel values and therefore do NOT post). |
| POST | `/api/suggested-reviewers` | `{file_paths[], pr_author?}` | **Legacy deterministic scorer** (not part of the Claude tool-loop flow). Merges `findReviewersByFiles` ×2 weight + `findCodeTouchersByFiles` ×1 weight (counts capped at 20), resolves Slack IDs via `user_mappings`, and returns the top 5 mapped candidates as `{reviewers: [{ghe_login, score, files[], slack_user_id, display_name, reason, hasReviewed, hasAuthored}]}`. Retained for operational use; the live flow uses `/api/past-*` + Claude synthesis via `/api/pr-reviewers`. |

## Channel bootstrap (proactive user mapping)

Supports the `worker/channelBootstrap.ts` drain loop. Enqueued rows come from `src/services/channelBootstrap.ts` (called by `/pr-monitor add` and the `member_joined_channel` event). See `docs/database.md` → `channel_bootstrap_members` and `docs/architecture.md` §3b.

| Method | Path | Body / Query | Purpose |
|---|---|---|---|
| POST | `/api/bootstrap-claim` | `{limit?: number}` — coerced into `[1, 50]`, default 50 | Atomically claims pending (or stale `in_progress`) rows from `channel_bootstrap_members` via `claimPendingBootstrap`. Returns `{rows: [{id, channel_id, slack_user_id, email}]}`. (`src/index.ts:578`) |
| POST | `/api/bootstrap-complete` | `{results: BootstrapResult[]}` where each `result` is `{id, status: 'resolved'\|'unresolved'\|'pending', ...}` | Validates per-result shape then calls `updateBootstrapResults`. `resolved` requires non-empty `ghe_login`, `email`, `slack_user_id` (plus optional `display_name`). `pending` requires `attempts_delta === 1` and a string `last_error`. Returns `{ok: true, updated: <count>}`. (`src/index.ts:605`) |

## Slack interaction (not HTTP — for reference)

These are not `/api/*` routes but Bolt-registered slash command in `src/app.ts`:

- `/pr-monitor` slash command subcommands: `add`, `remove`, `list`, `pending`, `status`, `stats`, `help` (`src/app.ts:112`). The `add` subcommand also triggers `enqueueChannelBootstrap` via `setImmediate` after acking.
- `member_joined_channel` event handler (`src/app.ts:374-397`) enqueues a single-member bootstrap row for already-monitored allowlisted channels.
