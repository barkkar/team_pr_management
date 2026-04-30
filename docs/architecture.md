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
     scripts/checkReminders.ts        │  + pgvector │
                                      └─────────────┘
                          ▲
              HTTPS (API key)
                          │
┌─────────────────────────┴────────────────────────────────┐
│  Local VPN worker laptop                                 │
│  ├─ worker/localPRChecker.ts  (--watch = 5 min)          │
│  │   └─ spawns worker/prAnalyzer.js per PR               │
│  ├─ worker/prHarvester.ts     (batch)                    │
│  ├─ worker/repoHarvester.ts   (batch)                    │
│  ├─ worker/userMapper.ts                                 │
│  ├─ worker/reviewLearner.ts   (--watch = 10 min)         │
│  ├─ worker/bootstrapLearner.ts (one-shot)                │
│  └─ worker/testReview.ts      (dry-run)                  │
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
4. For newly tracked PRs: spawn `worker/prAnalyzer.js` as a child process to generate an AI review (see §4).
5. For closed PRs without stored lessons: fetch peer comments from GHE, call Claude to compare AI review vs peer comments, `POST /api/ai-lessons`.

### 4. AI review generation (prAnalyzer 3-pass)

Triggered per PR either by `localPRChecker` (live) or by `bootstrapLearner` (batch backfill) or by `testReview.ts --post` (dry-run). Pipeline:

1. Fetch PR details + unified diff (`Accept: application/vnd.github.v3.diff`) + file list from GHE.
2. (Removed — semantic vector search was dropped along with the Ollama integration.)
3. Per file, fetch content fingerprint → domain-scoped code examples via `POST /api/domain-code-examples`.
4. `POST /api/resolve-rules` → deterministic ontology match (`src/services/ontologyEngine.ts`). Files with no match are classified by Claude (`src/services/ruleClassifier.ts`) against the full taxonomy, then rules are fetched for the predicted domain IDs.
5. `POST /api/ai-learning-context` (recency-only) → recent lessons + user feedback.
6. Three Claude passes:
   - **Pass 1**: implementation bugs, using learning context.
   - **Pass 2**: rule compliance, using resolved ontology rules.
   - **Pass 3**: test coverage, using test-file diff.
7. Merge + dedupe comments, `POST /api/suggested-reviewers` for reviewer ranking, `POST /api/pr-analysis` → Heroku stores in `pr_analysis_results` **and** posts a threaded Slack reply via `formatSlackAnalysis` (`src/index.ts:77-286`).

### 5. Slack feedback loop

- Overall review: 👍/👎 buttons → `ai_review_helpful` / `ai_review_not_helpful` actions (`src/app.ts:381`) → opens a modal → `ai_review_feedback_modal` view handler writes to `ai_review_feedback`.
- Per-comment: 👍/👎 buttons are only rendered when the full message fits under Slack's 50-block limit (`src/index.ts:110-115`). Writes to `ai_comment_feedback`.
- Rule-level feedback is written via `POST /api/ontology/rule-feedback` (`src/index.ts:1385`) → `rule_feedback` table.

### 6. Learning loop

Two paths converge on `ai_review_lessons`:

- **In-line**: `localPRChecker` extracts lessons as soon as a PR closes.
- **Polling**: `worker/reviewLearner.ts --watch` runs every 10 min; `worker/bootstrapLearner.ts` does a batch backfill (default 50 PRs, `--force` re-processes).

Each stores `lessons_json`. `GET /api/ai-learning-context` returns the N most recent lessons. Consumed by `prAnalyzer` Pass 1.

## Critical timing / business rules

- Reminder delay: **2 hours** (`src/utils/timezone.ts:3`).
- Business hours: **9 AM – 5 PM** PST, Mon–Fri (`src/utils/timezone.ts:4-6`).
- If a PR is posted ≥ 5 PM, its first reminder shifts to the next 9 AM business day (`src/utils/timezone.ts:19-31, 38-52`).
- Worker status freshness threshold: **10 min** (`src/services/reminder.ts:38-44`). Reminders are suppressed when the stored status is staler than that — forces waiting for fresh worker data.
- `localPRChecker` polling loop: **5 min** (`worker/localPRChecker.ts:39`).
- `reviewLearner` polling loop: **10 min** (`worker/reviewLearner.ts:22`).
- Slack section text limit: **2900 chars** (`src/index.ts:56`, leaves margin vs Slack's 3000 limit). Blocks are capped at **50** per message; per-comment feedback buttons are skipped when that would overflow.

## Ontology review in one paragraph

A directed graph of `code_domains` (parent_id references the same table for hierarchy), `code_rules` belonging to a domain, `rule_matchers` (code-pattern or annotation), and `domain_file_mappings` (glob pattern → domain). `resolveRulesForPR` walks file paths against glob mappings (minimatch, `dot: true, nocase: true`), then fetches every rule for the matched domains and their ancestors via a recursive CTE, then scans the diff text for `code_pattern`/`annotation` matchers that resolve to additional rules. Files with zero deterministic hits get sent to the LLM classifier, which picks a subset of domain IDs from the taxonomy; rules are fetched for those. See `docs/ontology.md`.

## What *not* to do

- Don't call GHE from `src/`. It won't work from Heroku.
- Don't bypass `channelAccessControl` — the app hard-exits without `ALLOWED_CHANNEL_IDS` and silently drops blocked channels.
- Don't trust `process.env.WORKER_API_KEY` being set locally; copy it from Heroku with `heroku config:get WORKER_API_KEY`.
