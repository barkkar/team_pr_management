# Architecture

## Runtime topology

```
                       ┌─────────────────────────┐
                       │  Slack workspace        │
                       │  • /pr-monitor command  │
                       │  • PR-link messages     │
                       └──────────┬──────────────┘
                     Socket Mode  │  HTTP (slash/actions)
                                  ▼
┌─────────────────────────────────────────────────────────┐
│  Heroku dyno (src/index.ts)                             │
│  ├─ Slack Bolt app (src/app.ts)                         │
│  ├─ HTTP server on PORT (src/index.ts:142)              │
│  │   ├─ /health                                         │
│  │   └─ /api/*  (X-Worker-API-Key auth, 33-43)          │
│  └─ PostgreSQL pool (src/db/client.ts:4)                │
└──────────┬──────────────────────────────────────────────┘
           │                                 │
     Heroku Scheduler                 ┌──────┴──────┐
     (every ~10 min)                  │  Postgres   │
     scripts/checkReminders.ts        │             │
                                      └─────────────┘
                          ▲
              HTTPS (API key)
                          │
┌─────────────────────────┴────────────────────────────────┐
│  Local VPN worker laptop                                 │
│  ├─ worker/localPRChecker.ts  (--watch = 5 min)          │
│  │   ├─ runBootstrapDrainLoop() from channelBootstrap    │
│  │   └─ runSuggestReviewersLoop() from prAnalyzer        │
│  ├─ worker/prAnalyzer.ts      (reviewer-suggestion loop) │
│  ├─ worker/channelBootstrap.ts (email→GHE-login drain)   │
│  ├─ worker/userMapper.ts      (GHE↔Slack mappings)       │
│  └─ worker/testSuggestReviewers.ts (dry-run)             │
│                                                          │
│  External calls (from worker):                           │
│    • GitHub Enterprise *.soma.salesforce.com             │
│    • Claude (Bedrock gateway or direct Anthropic API)    │
└──────────────────────────────────────────────────────────┘
```

## Why this split

GitHub Enterprise (`*.soma.salesforce.com`) is only reachable inside the corporate network. Heroku can't hit it. So Heroku owns the DB and Slack plumbing, and any call that needs GHE is shipped to a laptop on VPN.

## Event & data flow

### 1. PR posted in Slack → tracked

1. Socket Mode receives `message` event (`src/app.ts:47`).
2. `isChannelAllowed` rejects non-allowlisted channels (`src/app.ts:63`; uses `ALLOWED_CHANNEL_IDS`).
3. `containsPRLink` regex-gates the message (`src/utils/prParser.ts:50`).
4. `trackPRsFromMessage` parses every matching PR URL and inserts a row into `tracked_prs` with `eligible_reminder_at = posted_at + 2h` (adjusted to 9–5 PST / skip weekends; see `src/utils/timezone.ts:16`).
5. Bot reacts with `:robot_face:` (ignores `already_reacted`).

### 2. Scheduler (every 10 min on Heroku)

`scripts/checkReminders.ts` runs two steps:

1. **Poll fallback** — `pollChannelsForPRs` walks channels from `monitored_channels` table + `POLL_CHANNEL_IDS` env var (dedup, allowlist-filtered), fetches new messages since last seen ts, and tracks PRs missed by Socket Mode.
2. **Reminders** — `processPendingReminders` posts reminders for rows in `getPendingReminders()` where `eligible_reminder_at <= NOW()` AND the worker-reported status is `is_open = TRUE, has_reviews = FALSE` (and the status was updated within the last 10 min — otherwise it waits for fresh worker data; see `src/services/reminder.ts:38-44`). Business-hours gate applies (`isWithinBusinessHours()`). Recurring schedule: if still unreviewed after a reminder, `scheduleNextReminder` sets `eligible_reminder_at` to the next 9-AM-PST business point and increments `reminder_count`.

### 3. VPN worker loop

`worker/localPRChecker.ts` (`--watch` = 5-min loop) — one process on the laptop handles PR-status polling, bootstrap-queue drain, and reviewer-suggestion polling, in order:

1. `GET /api/pending-prs` → list of PRs due for a status check.
2. For each: call GHE `GET /repos/{org}/{repo}/pulls/{n}` + `/reviews` (per-hostname token from `gheTokenResolver`), compute `is_open` + `has_reviews`.
3. `POST /api/pr-status` with `{ results: [...] }` → Heroku updates `tracked_prs`.
4. `await runBootstrapDrainLoop()` — dynamically imported from `worker/channelBootstrap.ts` (`worker/localPRChecker.ts:225`). Claims up to 50 rows from `channel_bootstrap_members`, resolves each Slack email to a GHE login by searching every configured GHE host and confirming the email matches the returned user, then POSTs results to `/api/bootstrap-complete`. Paces at `CHANNEL_BOOTSTRAP_PACE_MS` (default 2100ms) between rows to stay under GHE secondary-rate-limit thresholds. Errors here are logged but do NOT fail later steps.
5. `await runSuggestReviewersLoop()` — imported at top-of-file from `worker/prAnalyzer.ts` (`worker/localPRChecker.ts:23, call at 234`). See §4 for what this does. Errors here are logged but do NOT fail the earlier steps.

### 3b. Channel bootstrap (proactive user mapping)

When a channel is added via `/pr-monitor add` (`src/app.ts:122-194`), the slash-command ack returns immediately and `setImmediate` runs `enqueueChannelBootstrap(channelId, client)` from `src/services/channelBootstrap.ts`. That helper pages through `conversations.members` + a 5-min-TTL cached `users.list`, filters out bots / deleted / no-email members, and bulk-inserts survivors into `channel_bootstrap_members` (`insertBootstrapMembers` uses `ON CONFLICT (channel_id, slack_user_id) DO NOTHING`). A separate `member_joined_channel` handler (`src/app.ts:374-397`) enqueues single users for already-monitored allowlisted channels.

The VPN worker drains the queue on every `localPRChecker` tick (§3 step 4). Resolved rows upsert into `user_mappings` with `discovered_via='bootstrap_search'`; `pending` rows increment `attempts` and age out at 3.

### 4. Reviewer suggestion (prAnalyzer tool-use loop)

`worker/prAnalyzer.ts` exports `runSuggestReviewersLoop()` which polls `GET /api/prs-needing-reviewer-suggestions` (tracked PRs with `suggestions_sent=FALSE` from the last 24h, LIMIT 10). It's called from two entry points:

- **Automatic**: `localPRChecker.ts` calls it every tick of the `--watch` loop (§3 step 4). This is the normal operating mode.
- **Standalone CLI**: `npm run suggest-reviewers` (polling) or `npm run suggest-reviewers -- <pr-url>` (one-shot — but note this uses `channel_id='manual'` / `message_ts='0'`, which the server explicitly skips for Slack posting: no thread reply for CLI one-shots).

For each PR, the worker invokes Claude via `claudeToolLoop` (defined at `src/services/claudeClient.ts:298`) with five tools:
- `fetch_pr_files(pr_url)` → `{ file_paths: string[], pr_author: string }` (paginates GHE `/pulls/{n}/files`, capped at 10 pages/1000 files).
- `fetch_pr_diff(pr_url, max_bytes?)` → unified diff text (default cap 60000 bytes).
- `get_channel_members(channel_id)` → resolved channel members from `/api/channel-members` (Heroku DB join of `channel_bootstrap_members` × `user_mappings`).
- `get_file_history(host, org, repo, file_path, limit?)` → recent commits touching `file_path` via `fetchFileCommits` (live GHE call to `/repos/{org}/{repo}/commits?path=`).
- `get_pr_reviewers(host, org, repo, pr_number)` → reviewers + reviewers-as-commenters for the given PR via `fetchPrReviews` (live GHE call to `/pulls/{n}/reviews` and `/pulls/{n}/comments`).

The system prompt instructs Claude to call `get_channel_members` first and only suggest reviewers from that set. The worker executes each tool call against GHE directly (`fetch_pr_*`, `get_file_history`, `get_pr_reviewers`) or the Heroku API (`get_channel_members`) and returns results. After up to 6 rounds (`TOOL_CALL_CAP = 6` in `worker/prAnalyzer.ts:38`; matches `claudeToolLoop`'s default `maxIterations`), Claude returns a JSON object with up to 5 suggested reviewers.

Post-Claude, the worker filters the suggestions to GHE logins that appear in the channel-members list (defence in depth — Claude is also told this). If the channel has zero resolved members, the worker skips Claude entirely and `/api/pr-reviewers` posts a "channel not bootstrapped" Slack notice instead of a reviewer list.

The JSON is parsed with `extractJsonFromClaudeText` (handles markdown fences and preamble — common Claude Opus 4.x behavior); on parse failure, the worker POSTs `suggestions=[]` to prevent infinite retries. The worker POSTs the filtered list to `/api/pr-reviewers`; the Heroku app resolves Slack IDs via `user_mappings`, sets `tracked_prs.suggestions_sent=TRUE`, and posts a threaded Slack reply when `channel_id !== 'manual'` and `message_ts !== '0'` (CLI one-shots use those sentinel values and silently skip the Slack post).


## Critical timing / business rules

- Reminder delay: **2 hours** (`src/utils/timezone.ts:3`).
- Business hours: **9 AM – 5 PM** PST, Mon–Fri (`src/utils/timezone.ts:4-6`).
- If a PR is posted ≥ 5 PM, its first reminder shifts to the next 9 AM business day (`src/utils/timezone.ts:19-31, 38-52`).
- Worker status freshness threshold: **10 min** (`src/services/reminder.ts:38-44`). Reminders are suppressed when the stored status is staler than that — forces waiting for fresh worker data.
- `localPRChecker` polling loop: **5 min** (`worker/localPRChecker.ts:37`).
- Bootstrap drain pacing: **2100 ms** default between rows (`CHANNEL_BOOTSTRAP_PACE_MS`, `worker/channelBootstrap.ts:33`).
- `enqueueChannelBootstrap` caches `users.list` for **5 min** and paces pagination at **200 ms** per page (`src/services/channelBootstrap.ts:20-24`).


## What *not* to do

- Don't call GHE from `src/`. It won't work from Heroku.
- Don't bypass `channelAccessControl`. When `ALLOWED_CHANNEL_IDS` is set, non-allowlisted channels are silently dropped in Socket Mode (`src/app.ts:64`) and the `/pr-monitor add` slash command (`src/app.ts:124`). When unset or empty, enforcement is **disabled** and a warning is logged; set the env var to re-enable.
- Don't trust `process.env.WORKER_API_KEY` being set locally; copy it from Heroku with `heroku config:get WORKER_API_KEY`.
