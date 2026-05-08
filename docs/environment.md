# Environment variables

All `process.env.*` reads in the codebase. Required means the process hard-exits (or a specific feature fails) if missing.

## Required — Heroku dyno

| Var | Read at | Purpose |
|---|---|---|
| `SLACK_BOT_TOKEN` | `src/app.ts:29` | Slack bot auth (`xoxb-…`). Hard-required by `main()` (`src/index.ts:96-102`). Also read by `src/utils/errorNotifier.ts:5`, `scripts/checkReminders.ts`, and several workers. |
| `SLACK_SIGNING_SECRET` | `src/app.ts:30` | Slack signing secret. Hard-required. |
| `SLACK_APP_TOKEN` | `src/app.ts:32` | App-level token for Socket Mode (`xapp-…`). Hard-required. |
| `ALLOWED_CHANNEL_IDS` | `src/services/channelAccessControl.ts:18` | Comma-separated Slack channel IDs the bot may read. When unset or empty, enforcement is **disabled** — a warning is logged and `isChannelAllowed` returns `true` for every channel (see commit `f40897d`). Set this to re-enable enforcement. |
| `GHE_TOKEN` **or** `GHE_TOKENS` | `src/utils/gheTokenResolver.ts:22, 54` | GitHub Enterprise PAT(s). `GHE_TOKENS` is a JSON map `{host: token}` (preferred). At least one must be set — Heroku dyno checks at `src/index.ts:104-107`; workers re-check at their own startup. |
| `DATABASE_URL` | `src/db/client.ts:5` | Postgres connection string. Auto-set by Heroku Postgres addon. |

## Required — local VPN worker

| Var | Purpose |
|---|---|
| `HEROKU_API_URL` | Base URL to the Heroku app (e.g., `https://pr-manager.herokuapp.com`). Every worker reads this. |
| `WORKER_API_KEY` | Shared secret — must match Heroku's `WORKER_API_KEY` Heroku config var. Every worker sets this as `X-Worker-API-Key`. |
| `GHE_TOKEN` **or** `GHE_TOKENS` | Same as Heroku; workers call GHE directly. |
| For Claude: `ANTHROPIC_BEDROCK_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (preferred) or `ANTHROPIC_API_KEY` (fallback). `claudeChat` and `claudeToolLoop` throw at call-time if neither pair is set (`src/services/claudeClient.ts`). |

## Optional

| Var | Default | Purpose |
|---|---|---|
| `CLAUDE_MODEL` | `claude-3-5-sonnet-20241022` (`src/services/claudeClient.ts:20`) | Claude model ID. Code default is the 3-5 Sonnet above; Heroku production overrides via this env var. `.env.example` documents `claude-sonnet-4-20250514`; the live Heroku app is currently running `claude-opus-4-6-v1`. |
| `ANTHROPIC_BEDROCK_BASE_URL` | — | Internal Bedrock gateway URL. If set with `ANTHROPIC_AUTH_TOKEN`, Bedrock mode is used. |
| `ANTHROPIC_AUTH_TOKEN` | — | Auth token for the Bedrock gateway. |
| `ANTHROPIC_API_KEY` | — | Direct Anthropic API key. Used only if Bedrock vars are not both set. |
| `WORKER_API_KEY` (Heroku side) | — | Optional — if unset, `validateApiKey` (`src/index.ts:33-43`) returns false and every `/api/*` route returns 401. `/health` and `/` still work. |
| `ERROR_SLACK_CHANNEL_ID` | — | Slack channel for errors via `notifyError` (`src/utils/errorNotifier.ts:6`). If unset, errors are logged to console only. |
| `POLL_CHANNEL_IDS` | — | Comma-separated legacy channel IDs to poll (`src/services/channelPoller.ts:35`), merged with `monitored_channels` table. |
| `PORT` | `3000` | HTTP server port (`src/index.ts:141`). Heroku sets this automatically. |
| `NODE_ENV` | — | If `production`, Postgres SSL uses `rejectUnauthorized: false` (`src/db/client.ts:6`). |
| `CHANNEL_BOOTSTRAP_PACE_MS` | `2100` | Milliseconds to sleep between rows in the bootstrap drain loop (`worker/channelBootstrap.ts:33`). Keeps GHE search well under the secondary-rate-limit threshold. Ignored if non-numeric. |
| `USER_MAPPINGS_JSON` | — | JSON map for manual GHE → Slack overrides in `worker/userMapper.ts:331`. |
| `TEST_PR_URL` | — | Optional PR URL for `scripts/testGheConnectivity.ts:193` to exercise an authenticated fetch. |
| `CHANNEL_ID` | — | Used by `scripts/deleteBotMessages.ts:16` as the target channel when no CLI arg is given. |

Note: `TZ` is **not** read by the code. The America/Los_Angeles timezone is hardcoded in `src/utils/timezone.ts:3` and Luxon's `.setZone()` uses that literal. Setting `TZ` affects only `console.log` timestamps and any shell-level tooling, not the business-hours math.

## Config files at a glance

- `.env.example` — template; documented vars mirror this file. Copy to `.env` locally.
- `tsconfig.json` — `target: ES2020`, `module: commonjs`, `outDir: ./dist`, `rootDir: .`, `strict: true`. Emits declaration + source maps.
- `package.json` — Node 20.x, npm 10.x. Scripts documented in `README.md` + `docs/workers.md`.
- `Procfile` — `release: npm run migrate`; `web: node dist/src/index.js`. No worker process type.
- `.gitignore` — standard (`node_modules/`, `.env`, IDE, OS, logs).
- `.claude/settings.local.json` — pre-allows `git add/commit`, `heroku pg:psql`, `heroku config:get`, `heroku run`, `heroku info`, `curl`, `jq`, `grep`, `head`, `tee` for the Claude Code harness.
- `.cursor/` — empty (placeholder).

## Dependencies (runtime)

| Package | Used by | Purpose |
|---|---|---|
| `@anthropic-ai/sdk` | `claudeClient.ts` | Direct-API Claude client (fallback mode). |
| `@slack/bolt` | `app.ts`, `index.ts`, some workers | Slack app framework (Socket Mode + events + actions). |
| `axios` | `claudeClient.ts` (Bedrock), `github.ts`, workers | HTTP client for GHE + Bedrock + Heroku API. |
| `dotenv` | `src/index.ts:1` etc. | Loads `.env` at startup. |
| `luxon` | `src/utils/timezone.ts` | Timezone-aware datetime. |
| `minimatch` | (legacy) | Previously used for glob matching. |
| `pg` | `src/db/client.ts`, migrate.ts | Postgres. |

Dev deps: `typescript` 5.7, `ts-node` 10.9, `@types/*` for `luxon`, `minimatch`, `node`, `pg`.
