# Workers & scripts

Everything in `worker/` and `scripts/`. Deployment split is at the bottom.

## Worker API contract

All workers authenticate with `X-Worker-API-Key` against `WORKER_API_KEY`. Base URL is `HEROKU_API_URL`. See `docs/api-endpoints.md` for the full endpoint catalog.

## Live workers

### `worker/localPRChecker.ts`

- **CLI**: `npm run worker` (once), `npm run worker:watch` / `node ... --watch` (5-min loop).
- **Env**: `HEROKU_API_URL`, `WORKER_API_KEY`, `GHE_TOKEN` or `GHE_TOKENS`, plus anything `prAnalyzer` + `channelBootstrap` need (Claude vars for prAnalyzer; `CHANNEL_BOOTSTRAP_PACE_MS` optional for bootstrap).
- **Loop (each tick)**:
  1. `GET /api/pending-prs` → list of PRs to check.
  2. For each: GHE call for PR + reviews (via `axios`, per-hostname token from `gheTokenResolver`).
  3. `POST /api/pr-status` with `{ results: [...] }`.
  4. `await runBootstrapDrainLoop()` — dynamically imported from `./channelBootstrap` (`localPRChecker.ts:225`). Drains `channel_bootstrap_members` by searching each configured GHE host for the member email and posts results to `/api/bootstrap-complete`. Errors here are logged but do NOT fail later steps.
  5. `await runSuggestReviewersLoop()` — imported from `./prAnalyzer`. Runs the reviewer-suggestion loop for any PRs in `tracked_prs` with `suggestions_sent=FALSE` from the last 24h. Errors here are logged but do NOT fail the earlier steps.
- **Constants**: `POLL_INTERVAL_MS = 5 * 60 * 1000`; GHE timeout 10s.
- **Idempotency**: driven by Heroku-side `status_checked_at` (status poll), `channel_bootstrap_members.status` (bootstrap), and `suggestions_sent` flag on `tracked_prs` (reviewer suggestions). Safe to re-run.

### `worker/prAnalyzer.ts`

- **CLI (standalone)**: `npm run suggest-reviewers -- <pr-url>` (one-shot for a single PR — uses `channel_id='manual'`, `message_ts='0'`; server stores the result but skips the Slack post), or `npm run suggest-reviewers` (no arg) to poll `/api/prs-needing-reviewer-suggestions` once and process each PR.
- **Primary consumer**: `localPRChecker.ts` imports `runSuggestReviewersLoop()` (exported) and calls it every tick. The `run()` entry is guarded by `require.main === module` so importing does NOT trigger the standalone flow.
- **Env**: GHE + Claude (`ANTHROPIC_BEDROCK_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, or `ANTHROPIC_API_KEY` as fallback).
- **Pipeline (per PR, tool-use loop)**:
  1. Invoke Claude via `claudeToolLoop` with four tools: `fetch_pr_files`, `fetch_pr_diff`, `get_past_reviewers`, `get_past_authors`.
  2. Claude decides what to fetch; the worker executes each tool call against GHE (`fetch_pr_*`) or Heroku API (`get_past_*`), returns results as `tool_result` blocks.
  3. After up to 6 rounds (`maxIterations` cap in `claudeToolLoop`), Claude returns a JSON object `{suggestions: [{ghe_login, reason}]}` (up to 5).
  4. `extractJsonFromClaudeText` parses the output, tolerating markdown fences and prose preamble (Claude Opus 4.x behavior).
  5. `POST /api/pr-reviewers` → Heroku resolves Slack IDs via `user_mappings`, marks `suggestions_sent=TRUE`, and posts a threaded reply (when the PR was posted in a real channel, not a CLI one-shot).
  6. On parse failure, the worker POSTs `suggestions=[]` anyway to prevent infinite retries.


### `worker/channelBootstrap.ts`

- **CLI**: `npx ts-node worker/channelBootstrap.ts` (one-shot drain; exits when the claimed batch is done). Normal operation is via `localPRChecker`'s tick loop, not standalone.
- **Primary consumer**: `localPRChecker.ts` dynamically imports `runBootstrapDrainLoop()` every tick.
- **Env**: `HEROKU_API_URL`, `WORKER_API_KEY`, `GHE_TOKEN` or `GHE_TOKENS` (at least one GHE host must be configured), optional `CHANNEL_BOOTSTRAP_PACE_MS` (default 2100).
- **Flow (one batch per call)**:
  1. `POST /api/bootstrap-claim` with `{ limit: 50 }` → up to 50 claimed rows (pending or stale in_progress).
  2. For each row: iterate configured GHE hosts in priority order (`listConfiguredHosts()`), call `GET /api/v3/search/users?q=<email>+in:email`, then `GET /api/v3/users/{login}` to confirm the returned user's email matches. First match wins. Rate-limit headers from the first call per host per tick are logged.
  3. Classification per row: `resolved` (found + email match), `unresolved` (no host returned a match), or `pending` with `attempts_delta=1` + `last_error` on transient HTTP errors (ECONNRESET/ETIMEDOUT/429/403/5xx). Non-transient errors bubble up to abort the batch.
  4. Pace `CHANNEL_BOOTSTRAP_PACE_MS` ms between rows (not after the last).
  5. If `rows.length ≥ 4` and `unresolved/claimed > 0.5`, emit a `notifyError('ChannelBootstrap', 'High unresolved ratio on bootstrap drain', 'warn')` with throttling.
  6. `POST /api/bootstrap-complete` with the per-row results.

## Batch / harvest workers

### `worker/prHarvester.ts`

- **CLI**: `npm run harvest` (incremental — skips PRs already in `pr_reviews`), `npm run harvest:incremental` (alias via `--incremental` flag), `HARVEST_ALL=1 npm run harvest` (re-harvest every tracked PR).
- **Env**: `HEROKU_API_URL`, `WORKER_API_KEY`, `GHE_TOKEN` or `GHE_TOKENS`, optional `HARVEST_ALL=1`.
- Pulls PR details, review comments (`/pulls/{n}/comments`), top-level reviews (`/pulls/{n}/reviews`, only those with a body), and changed files (`/pulls/{n}/files`) for each tracked PR. `diff_hunk` truncated to 2000 chars, `patch_snippet` to 3000. Uploads via `POST /api/harvest-data`. 300ms between PRs.

### `worker/userMapper.ts`

- **CLI**: `npm run map-users`.
- Strategy cascade per GHE login: (1) email → `users.lookupByEmail` on Slack, (2) name → `users.list` pagination (200/page) + fuzzy match, (3) `USER_MAPPINGS_JSON` env manual overrides.
- Uploads via `POST /api/user-mappings`.

### `worker/testSuggestReviewers.ts`

- **CLI**: `npm run test-suggest-reviewers -- <pr-url>` (dry-run with detailed logging); append `--post --channel=C123` to actually post via `/api/pr-reviewers`.
- **Env**: GHE + Claude for the dry-run; also `SLACK_BOT_TOKEN` if `--post` is used.
- **Pipeline**: same tool-use flow as `prAnalyzer` — `claudeToolLoop` with the four tools `fetch_pr_files`, `fetch_pr_diff`, `get_past_reviewers`, `get_past_authors` — but inline (no DB writes) and with detailed logging. Use this before shipping any prAnalyzer changes.

## Scripts

### `scripts/checkReminders.ts`

Heroku Scheduler entry point.

- **CLI**: `npm run check-reminders`.
- Runs `pollChannelsForPRs(slackClient)` → `processPendingReminders(app)` → closes the DB pool.
- Schedule: every 10 minutes (see `README.md`).

### `scripts/deleteBotMessages.ts`

One-off cleanup utility. Deletes bot-authored messages (or messages containing "Reminder") in a channel. `CHANNEL_ID=C0123 npm run delete-bot-messages` or `npx ts-node scripts/deleteBotMessages.ts C0123`. 200ms between deletes.

### `scripts/testGheConnectivity.ts`

Diagnostic for GHE reachability.

- **CLI**: `npm run test-ghe`, typically `heroku run npm run test-ghe`.
- For each known GHE hostname: DNS resolve → HTTPS GET `/api/v3` → authenticated GET `/api/v3/user`. If `TEST_PR_URL` is set, also fetches that PR.
- Exits 0 on all-pass, 1 otherwise.

### `scripts/testChannelBootstrapEnqueue.ts`

Diagnostic for the channel-bootstrap enqueue path.

- **CLI**: `npx ts-node scripts/testChannelBootstrapEnqueue.ts <channel-id>`.
- **Env**: `SLACK_BOT_TOKEN`, `DATABASE_URL`.
- Calls `enqueueChannelBootstrap(channelId, slackClient)` for the given channel and prints the most recent 50 rows from `channel_bootstrap_members`.

### `scripts/testListConfiguredHosts.ts`

Diagnostic for GHE host configuration.

- **CLI**: `npx ts-node scripts/testListConfiguredHosts.ts`.
- Prints the configured GHE hostnames in the search-priority order used by `worker/channelBootstrap.ts` (`listConfiguredHosts()` from `src/utils/gheTokenResolver.ts`).

## Deployment matrix

| File | Runs on Heroku | Runs on VPN laptop |
|---|---|---|
| `scripts/checkReminders.ts` | ✅ (Scheduler) | — |
| `scripts/testGheConnectivity.ts` | ✅ (diagnostic) | — |
| `scripts/testChannelBootstrapEnqueue.ts` | — | ✅ (diagnostic, needs Slack) |
| `scripts/testListConfiguredHosts.ts` | — | ✅ (diagnostic) |
| `scripts/deleteBotMessages.ts` | — | ✅ (manual) |
| `worker/localPRChecker.ts` | — | ✅ (needs GHE; orchestrates bootstrap + reviewer loops) |
| `worker/prAnalyzer.ts` | — | ✅ (needs GHE + Claude) |
| `worker/channelBootstrap.ts` | — | ✅ (needs GHE) |
| `worker/prHarvester.ts` | — | ✅ (needs GHE) |
| `worker/userMapper.ts` | — | ✅ (Slack + GHE) |
| `worker/testSuggestReviewers.ts` | — | ✅ (needs GHE + Claude) |

Heroku's `Procfile` has no `worker:` process type. All continuous workers are laptop-resident.
