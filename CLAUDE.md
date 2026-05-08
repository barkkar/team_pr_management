# CLAUDE.md

Orientation for Claude sessions working in this repo. Keep this file short — deep references live in `docs/`.

## What this repo is

A Slack bot + background-worker system that watches team Slack channels for GitHub Enterprise PR links, tracks them in Postgres, sends review reminders during PST business hours, and posts suggested reviewers using a Claude tool-use loop (Claude decides what PR data to fetch; the worker executes tool calls; Claude returns reviewer suggestions with reasons).

See `README.md` for end-user setup. This file exists for Claude.

## Runtime split (non-obvious)

The system is deliberately split in two because GitHub Enterprise (`*.soma.salesforce.com`) is only reachable from the corporate VPN:

1. **Heroku dyno** (`src/`) — Slack Bolt app in Socket Mode + HTTP server exposing `/api/*` endpoints. Owns Postgres. Cannot reach GHE.
2. **Local VPN worker** (`worker/`) — runs on a laptop on VPN. Pulls work from Heroku via HTTP, calls GHE + Claude, posts results back.

All `worker/*` calls to `${HEROKU_API_URL}/api/*` are authenticated with the `X-Worker-API-Key` header (`src/index.ts:33-43`; `Authorization: Bearer <token>` is also accepted). The only exception is `scripts/checkReminders.ts`, which runs on Heroku Scheduler.

## Entry points

| Path | Role |
|---|---|
| `src/index.ts` | Boots Slack app (Socket Mode) + HTTP server on `PORT`. Defines every `/api/*` endpoint and the Slack message-block formatter. |
| `src/app.ts` | Slack Bolt app: message handler, `/pr-monitor` slash command, app_home. |
| `scripts/checkReminders.ts` | Heroku Scheduler job: `pollChannelsForPRs` + `processPendingReminders`. |
| `worker/localPRChecker.ts` | Main VPN worker loop (default / `--watch` every 5 min). Each tick: poll PR status, drain bootstrap queue, then call `runSuggestReviewersLoop()` from `prAnalyzer`. |
| `worker/prAnalyzer.ts` | Exports `runSuggestReviewersLoop()` (called by `localPRChecker`) and a CLI entry for standalone runs. Invokes Claude via `claudeToolLoop` with five tools. |
| `worker/channelBootstrap.ts` | Exports `runBootstrapDrainLoop()` (called by `localPRChecker`). Claims rows from `channel_bootstrap_members`, resolves Slack emails to GHE logins via configured GHE hosts, posts results to `/api/bootstrap-complete`. |
| `worker/userMapper.ts` | Batch job (`npm run map-users`). Discovers GHE↔Slack mappings by email lookup + name fuzzy-match + `USER_MAPPINGS_JSON` overrides. |
| `worker/testSuggestReviewers.ts` | Dry-run harness for the reviewer-suggestion tool-loop (`npm run test-suggest-reviewers -- <pr-url>`). Same five tools; no DB writes unless `--post --channel=C123` is passed. |

## Documentation layout

Start with the doc that matches the task:

- `docs/architecture.md` — runtime topology, data flow, request/event lifecycles. Read first if unsure where something runs.
- `docs/database.md` — full schema catalog, every exported `src/db/client.ts` function.
- `docs/services.md` — per-module notes for `src/services/` and `src/utils/`.
- `docs/api-endpoints.md` — every HTTP route exposed by `src/index.ts`, grouped by function.
- `docs/workers.md` — what each `worker/*` and `scripts/*` file does, when to run it, how it's idempotent.
- `docs/environment.md` — every `process.env.*` read in the codebase, with required/optional + source location.

## House rules when editing

- **Don't assume** a change is complete after TypeScript compiles: most runtime behavior requires either Socket Mode connectivity or the worker loop to exercise. Dry-run with `npm run test-suggest-reviewers -- <pr-url>` when touching `worker/prAnalyzer.ts` / `worker/testSuggestReviewers.ts`.
- **Migrations are immutable once numbered.** `src/db/migrate.ts` applies `src/db/migrations/*.sql` in filename order, tracks applied files in `schema_migrations`, and has special seeding logic for 001–006 when upgrading an existing DB (`src/db/migrate.ts:20-47`). Add new migrations with the next sequential prefix.
- **Claude model** is whatever `CLAUDE_MODEL` env var says; the code default in `src/services/claudeClient.ts:20` is `claude-3-5-sonnet-20241022`, but production env currently runs `claude-opus-4-6-v1`. When updating model IDs, verify both the default string and the deployed Heroku config var.
- **Channel access control is enforced at module load** (`src/services/channelAccessControl.ts`). When `ALLOWED_CHANNEL_IDS` is unset or empty, enforcement is **disabled** (a warning is logged and every channel is permitted). Set the env var to a comma-separated list to re-enable enforcement; non-allowlisted channels are then silently dropped both in Socket Mode and the slash command.
- **Worker API auth is required.** If `WORKER_API_KEY` is unset on Heroku, `validateApiKey` (`src/index.ts:33-43`) always returns false and every `/api/*` endpoint returns 401. `/health` and `/` are public.
- **Errors should funnel through `notifyError`** (`src/utils/errorNotifier.ts`). It throttles to 1 per minute per source+message and gracefully no-ops if `ERROR_SLACK_CHANNEL_ID` is unset.
- **Claude has tool-use access via `claudeToolLoop`** (`src/services/claudeClient.ts`). The worker executes tools; Claude never makes HTTP calls itself.

## Common pitfalls

- The `pr_url` column is the de-facto primary key across `tracked_prs` and related tables. Joins assume string-equality on the full URL — never substring-match.
- The Heroku dyno cannot resolve GHE hostnames. If you add a feature that needs a live GHE call, route it through the worker.
- Some DB migrations touch the same table (`tracked_prs` 001/003/005/006/020). When reading schema, consult `docs/database.md` for the merged view, not a single migration file.
- The channel bootstrap queue (`channel_bootstrap_members`, migration 021) spans `src/` and `worker/`: the Heroku side enqueues members (`src/services/channelBootstrap.ts`, `src/app.ts` `/pr-monitor add` handler + `member_joined_channel` event), and the VPN worker drains them via `/api/bootstrap-claim` + `/api/bootstrap-complete`.

## Tooling

- Node 20.x, npm 10.x (`package.json:23-26`).
- TypeScript compiles to `dist/`. `npm run compile` also copies `src/db/migrations/*.sql` into `dist/src/db/migrations/` so the release script can find them.
- `Procfile` has two process types: `release: npm run migrate`, `web: node dist/src/index.js`. No `worker:` entry — worker runs on the laptop.
- `.claude/settings.local.json` pre-allows `git add/commit`, `heroku pg:psql`, `heroku config:get`, `heroku run`, `heroku info`, `curl`, `jq`, `grep`, `head`, `tee`.
