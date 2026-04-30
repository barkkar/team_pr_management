# Workers & scripts

Everything in `worker/` and `scripts/`. Deployment split is at the bottom.

## Worker API contract

All workers authenticate with `X-Worker-API-Key` against `WORKER_API_KEY`. Base URL is `HEROKU_API_URL`. See `docs/api-endpoints.md` for the full endpoint catalog.

## Live workers

### `worker/localPRChecker.ts`

- **CLI**: `npm run worker` (once), `npm run worker:watch` / `node ... --watch` (5-min loop).
- **Env**: `HEROKU_API_URL`, `WORKER_API_KEY`, `GHE_TOKEN` or `GHE_TOKENS`.
- **Loop**:
  1. `GET /api/pending-prs` → list of PRs to check.
  2. For each: GHE call for PR + reviews via `GitHubEnterpriseClient`.
  3. `POST /api/pr-status` with `{ results: [...] }`.
- **Constants**: `POLL_INTERVAL_MS = 5 * 60 * 1000`; GHE timeout 10s.
- **Idempotency**: driven by Heroku-side `status_checked_at`. Safe to re-run.
- Reviewer suggestions are produced independently by `worker/prAnalyzer.ts` — this worker does PR-status polling only.

### `worker/prAnalyzer.ts`

- **CLI**: `npm run suggest-reviewers -- <pr-url>` (single PR), or `npm run suggest-reviewers` to poll `/api/prs-needing-reviewer-suggestions`.
- **Env**: GHE + Claude only.
- **Pipeline** (tool-use loop):
  1. Fetch PR metadata from GHE.
  2. Invoke Claude with four tools: `fetch_pr_files`, `fetch_pr_diff`, `get_past_reviewers`, `get_past_authors`.
  3. Claude decides what to fetch; worker executes tool calls against GHE + Postgres, returns results.
  4. After up to 6 rounds, Claude returns a JSON list of up to 5 suggested reviewers with reasons.
  5. `POST /api/pr-reviewers` → Heroku resolves Slack IDs via `user_mappings`, posts threaded reply, marks `suggestions_sent=TRUE`.


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
