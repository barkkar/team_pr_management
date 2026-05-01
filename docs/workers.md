# Workers & scripts

Everything in `worker/` and `scripts/`. Deployment split is at the bottom.

## Worker API contract

All workers authenticate with `X-Worker-API-Key` against `WORKER_API_KEY`. Base URL is `HEROKU_API_URL`. See `docs/api-endpoints.md` for the full endpoint catalog.

## Live workers

### `worker/localPRChecker.ts`

- **CLI**: `npm run worker` (once), `npm run worker:watch` / `node ... --watch` (5-min loop).
- **Env**: `HEROKU_API_URL`, `WORKER_API_KEY`, `GHE_TOKEN` or `GHE_TOKENS`, plus anything `prAnalyzer` needs (it gets spawned as a child process).
- **Loop**:
  1. `GET /api/pending-prs` → list of PRs to check.
  2. For each: GHE call for PR + reviews via `GitHubEnterpriseClient`.
  3. `POST /api/pr-status` with `{ results: [...] }`.
  4. For any PR that's newly tracked (not yet in `pr_analysis_results`), spawn `prAnalyzer.js <pr_url>` as a child process.
  5. `GET /api/prs-needing-lessons` → for each, pull peer comments from GHE, call Claude to compare AI review vs. peer comments, `POST /api/ai-lessons`.
- **Constants**: `POLL_INTERVAL_MS = 5 * 60 * 1000` (worker/localPRChecker.ts:39); GHE timeout 10s.
- **Idempotency**: driven by Heroku-side state (`status_checked_at`, `pr_analysis_results`, `ai_review_lessons`). Safe to re-run.
- **Env requirements**: GHE + Claude only.

### `worker/prAnalyzer.ts`

- **CLI**: `npm run analyze-pr -- <pr-url>` (single PR), or the worker's polling branch picks PRs from `/api/prs-needing-analysis`.
- **Env**: GHE + Claude only.
- **Pipeline** (3-pass ontology review):
  1. Fetch PR metadata + unified diff + file list from GHE.
  2. Per file, fetch content fingerprint (≤2000 chars), call `POST /api/domain-code-examples` for domain-scoped examples.
  3. `POST /api/resolve-rules` for deterministic rules + taxonomy + unmatched files.
  4. For unmatched files, call `classifyUnmatchedFiles` (Claude) against the taxonomy.
  5. `POST /api/ai-learning-context` for recent lessons + feedback.
  6. Three Claude passes: implementation bugs, rule compliance, test coverage. Merge + dedupe.
  7. `POST /api/suggested-reviewers`.
  8. `POST /api/pr-analysis` (Heroku stores + posts Slack thread reply).
- **Constants**: per-pass max 3 comments/file; severity `critical|high|medium|low`; diff truncation 16K; file fingerprint 2K; learning-context limit 5.

### `worker/reviewLearner.ts`

- **CLI**: `npm run review-learn` (once), `npm run review-learn:watch` (10-min loop).
- **Env**: `HEROKU_API_URL`, `WORKER_API_KEY`, `GHE_TOKEN`/`GHE_TOKENS`, Claude vars.
- **Loop**:
  1. `GET /api/prs-needing-lessons`.
  2. For each, GHE call for peer review comments.
  3. Claude compares AI review ↔ peer comments and returns structured lessons.
  4. `POST /api/ai-lessons`.
  5. If the PR has zero peer comments, write a placeholder lesson so the PR is skipped in future runs.
- **Constants**: `POLL_INTERVAL_MS = 10 * 60 * 1000`; 1s between PRs.
- **Overlap warning**: `localPRChecker` also does lesson extraction inline on close. Don't add a third extraction path — pick one when changing behavior.

## Batch / harvest workers

### `worker/prHarvester.ts`

- **CLI**: `npm run harvest` or `npm run harvest:incremental` (these are aliases — both run the same script, incremental mode). Set `HARVEST_ALL=1` to re-process everything.
- **Input**: `/api/tracked-prs-for-harvest` (incremental) or `/api/all-tracked-prs`.
- **Per PR**: calls GHE `/pulls/{n}/comments` (inline review comments), `/pulls/{n}/reviews` (top-level), `/pulls/{n}/files`. Uploads batch to `/api/harvest-data`.
- **Rate**: 300ms delay between PRs; `per_page=100` pagination.

### `worker/repoHarvester.ts`

- **CLI**: `npm run harvest:repos`.
- Gets distinct repos from `/api/distinct-repos`. Skips repos already harvested at the current commit SHA (`harvest_state.last_repo_harvest_sha`).
- Pulls the full recursive tree, filters by extension whitelist (ts/tsx/js/py/java/go/sql/md/yaml/...) and `MAX_FILE_SIZE=50000`, chunks content at `CHUNK_SIZE=1500` with `CHUNK_OVERLAP=200`.
- For each chunk: regex-extracts `code_element_type` + `code_element_name`, and resolves `domain_id` via `/api/domain-file-mappings`.
- Uploads in batches of 20 to `/api/repo-knowledge`.

### `worker/userMapper.ts`

- **CLI**: `npm run map-users`.
- Strategy cascade per GHE login: (1) email → `users.lookupByEmail` on Slack, (2) name → `users.list` pagination (200/page) + fuzzy match, (3) `USER_MAPPINGS_JSON` env manual overrides.
- Uploads via `POST /api/user-mappings`.

### `worker/bootstrapLearner.ts`

- **CLI**: `npm run bootstrap-learn [-- --limit N] [-- --force]`. Default limit 50.
- **Env**: GHE + Claude only.
- One-shot batch: pulls `/api/closed-prs-without-lessons?limit=N&force={bool}` and runs the full `prAnalyzer` pipeline + lesson extraction per PR. 2s delay between PRs.
- `--force` pulls all closed PRs that have an AI review stored (used to backfill old rows).

### `worker/testReview.ts`

- **CLI**:
  - Dry-run: `npm run test-review -- <pr-url>` (prints to console, no DB writes, no Slack).
  - Suppress @mentions: `npm run test-review -- <pr-url> --no-mention`.
  - Post to Slack (still no DB writes): `npm run test-review -- <pr-url> --post --channel=C123`.
- **Env**: GHE + Claude only.
- Runs the same pipeline as `prAnalyzer` but with heavy logging. Use this before shipping any prAnalyzer/ontology change.

### Backfill scripts (one-offs)

- `worker/backfillDomainMetadata.ts` — batches 10K `repo_knowledge` rows, populates `domain_id` + `code_element_type` + `code_element_name`.
- `worker/backfillDomainMetadataComplete.ts` — same, but 5K batches and processes until done.
- `worker/backfillDomainMetadataWithLogging.ts` — with per-row skip logging.

All three connect to `DATABASE_URL` directly (no Heroku API). Run with `DATABASE_URL=... npx ts-node worker/backfillDomainMetadata*.ts`.

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
| `worker/testReview.ts` | — | ✅ |
| `worker/prHarvester.ts` | — | ✅ |
| `worker/repoHarvester.ts` | — | ✅ |
| `worker/userMapper.ts` | — | ✅ (Slack + GHE) |
| `worker/bootstrapLearner.ts` | — | ✅ |
| `worker/reviewLearner.ts` | — | ✅ (needs peer comments from GHE) |
| `worker/backfillDomainMetadata*.ts` | either (direct DB) | ✅ |

Heroku's `Procfile` has no `worker:` process type. All continuous workers are laptop-resident.
