# Workers & scripts

Everything in `worker/` and `scripts/`. Deployment split is at the bottom.

## Worker API contract

All workers authenticate with `X-Worker-API-Key` against `WORKER_API_KEY`. Base URL is `HEROKU_API_URL`. See `docs/api-endpoints.md` for the full endpoint catalog.

## Live workers

### `worker/localPRChecker.ts`

- **CLI**: `npm run worker` (once), `npm run worker:watch` / `node ... --watch` (5-min loop).
- **Env**: `HEROKU_API_URL`, `WORKER_API_KEY`, `GHE_TOKEN` or `GHE_TOKENS`, plus anything `prAnalyzer` needs (Claude vars) since it runs the reviewer-suggestion loop in-process.
- **Loop (each tick)**:
  1. `GET /api/pending-prs` → list of PRs to check.
  2. For each: GHE call for PR + reviews via `GitHubEnterpriseClient`.
  3. `POST /api/pr-status` with `{ results: [...] }`.
  4. `await runSuggestReviewersLoop()` — imported from `./prAnalyzer`. Runs the reviewer-suggestion loop for any PRs in `tracked_prs` with `suggestions_sent=FALSE` from the last 24h. Errors here are logged but do NOT fail the status-polling step.
- **Constants**: `POLL_INTERVAL_MS = 5 * 60 * 1000`; GHE timeout 10s.
- **Idempotency**: driven by Heroku-side `status_checked_at` (status poll) + `suggestions_sent` flag on `tracked_prs` (reviewer suggestions). Safe to re-run.

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


## Batch / harvest workers

### `worker/userMapper.ts`

- **CLI**: `npm run map-users`.
- Strategy cascade per GHE login: (1) email → `users.lookupByEmail` on Slack, (2) name → `users.list` pagination (200/page) + fuzzy match, (3) `USER_MAPPINGS_JSON` env manual overrides.
- Uploads via `POST /api/user-mappings`.

### `worker/testSuggestReviewers.ts`

- **CLI**: `npm run test-suggest-reviewers -- <pr-url>` (dry-run with detailed logging).
- **Env**: GHE + Claude only.
- Runs the same pipeline as `prAnalyzer` but with detailed logging and no DB writes. Use this before shipping any prAnalyzer changes.

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

## Deployment matrix

| File | Runs on Heroku | Runs on VPN laptop |
|---|---|---|
| `scripts/checkReminders.ts` | ✅ (Scheduler) | — |
| `scripts/testGheConnectivity.ts` | ✅ (diagnostic) | — |
| `scripts/deleteBotMessages.ts` | — | ✅ (manual) |
| `worker/localPRChecker.ts` | — | ✅ (needs GHE) |
| `worker/prAnalyzer.ts` | — | ✅ (needs GHE + Claude) |
| `worker/testSuggestReviewers.ts` | — | ✅ |
| `worker/userMapper.ts` | — | ✅ (Slack + GHE) |

Heroku's `Procfile` has no `worker:` process type. All continuous workers are laptop-resident.
