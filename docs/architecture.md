# Architecture

## Runtime topology

```
                       ┌─────────────────────────┐
                       │  Slack workspace        │
                       │  • /pr-monitor command  │
                       │  • PR-link messages     │
                       │  • Feedback buttons     │
                       └──────────┬──────────────┘
                     Socket Mode  │  HTTP (slash/actions)
                                  ▼
┌─────────────────────────────────────────────────────────┐
│  Heroku dyno (src/index.ts)                             │
│  ├─ Slack Bolt app (src/app.ts)                         │
│  ├─ HTTP server on PORT (src/index.ts:336)              │
│  │   ├─ /health                                         │
│  │   └─ /api/*  (X-Worker-API-Key auth)                 │
│  └─ PostgreSQL pool (src/db/client.ts:3)                │
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
│  │   └─ spawns worker/prAnalyzer.js per PR               │
│  ├─ worker/testSuggestReviewers.ts (dry-run)             │
│  └─ worker/userMapper.ts                                 │
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

`worker/localPRChecker.ts` (`--watch` = 5-min loop):

1. `GET /api/pending-prs` → list of PRs due for a status check.
2. For each: call GHE `GET /repos/{org}/{repo}/pulls/{n}` + `/reviews` (via `GitHubEnterpriseClient`, per-hostname token from `gheTokenResolver`), compute `is_open` + `has_reviews`.
3. `POST /api/pr-status` with `{ results: [...] }` → Heroku updates `tracked_prs`.
4. `GET /api/prs-needing-reviewer-suggestions` → for any PR needing suggestions, spawn `prAnalyzer.js` as a child process (see §4).

### 4. Reviewer suggestion (prAnalyzer tool-use loop)

Triggered per PR by `localPRChecker` when a new PR is detected. The worker invokes Claude with four tools (`fetch_pr_files`, `fetch_pr_diff`, `get_past_reviewers`, `get_past_authors`). Claude decides what to fetch; the worker executes each tool call against GHE + Postgres and returns results. After up to 6 rounds, Claude returns a JSON list of up to 5 suggested reviewers with reasons. The Heroku app resolves Slack IDs and posts a threaded reply.


## Critical timing / business rules

- Reminder delay: **2 hours** (`src/utils/timezone.ts:3`).
- Business hours: **9 AM – 5 PM** PST, Mon–Fri (`src/utils/timezone.ts:4-6`).
- If a PR is posted ≥ 5 PM, its first reminder shifts to the next 9 AM business day (`src/utils/timezone.ts:19-31, 38-52`).
- Worker status freshness threshold: **10 min** (`src/services/reminder.ts:38-44`). Reminders are suppressed when the stored status is staler than that — forces waiting for fresh worker data.
- `localPRChecker` polling loop: **5 min** (`worker/localPRChecker.ts:39`).


## What *not* to do

- Don't call GHE from `src/`. It won't work from Heroku.
- Don't bypass `channelAccessControl` — the app hard-exits without `ALLOWED_CHANNEL_IDS` and silently drops blocked channels.
- Don't trust `process.env.WORKER_API_KEY` being set locally; copy it from Heroku with `heroku config:get WORKER_API_KEY`.
