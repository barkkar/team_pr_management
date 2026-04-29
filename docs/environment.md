# Environment variables

All `process.env.*` reads in the codebase. Required means the process hard-exits (or a specific feature fails) if missing.

## Required — Heroku dyno

| Var | Read at | Purpose |
|---|---|---|
| `SLACK_BOT_TOKEN` | `src/app.ts:28` | Slack bot auth (`xoxb-…`). Hard-required by `main()` (`src/index.ts:290`). |
| `SLACK_SIGNING_SECRET` | `src/app.ts:29` | Slack signing secret. Hard-required. |
| `SLACK_APP_TOKEN` | `src/app.ts:31` | App-level token for Socket Mode (`xapp-…`). Hard-required. |
| `ALLOWED_CHANNEL_IDS` | `src/services/channelAccessControl.ts` | Comma-separated Slack channel IDs the bot may read. Module hard-exits on load if unset/empty. Also checked in `main()`. |
| `GHE_TOKEN` **or** `GHE_TOKENS` | `src/utils/gheTokenResolver.ts` | GitHub Enterprise PAT(s). `GHE_TOKENS` is a JSON map `{host: token}` (preferred). At least one must be set (`src/index.ts:298`). |
| `DATABASE_URL` | `src/db/client.ts:4` | Postgres connection string. Auto-set by Heroku Postgres addon. |

## Required — local VPN worker

| Var | Purpose |
|---|---|
| `HEROKU_API_URL` | Base URL to the Heroku app (e.g., `https://pr-manager.herokuapp.com`). Every worker reads this. |
| `WORKER_API_KEY` | Shared secret — must match Heroku's `WORKER_API_KEY` Heroku config var. Every worker sets this as `X-Worker-API-Key`. |
| `GHE_TOKEN` **or** `GHE_TOKENS` | Same as Heroku; workers call GHE directly. |
| For Claude: `ANTHROPIC_BEDROCK_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` (preferred) or `ANTHROPIC_API_KEY` (fallback). `claudeChat` throws at call-time if neither pair is set (`src/services/claudeClient.ts:184-187`). |

## Optional

| Var | Default | Purpose |
|---|---|---|
| `CLAUDE_MODEL` | `claude-3-5-sonnet-20241022` (`src/services/claudeClient.ts:21`) | Claude model ID. Code default is the 3-5 Sonnet above; production Heroku config may override via this var. `.env.example` shows `claude-sonnet-4-20250514` as the reference production value. |
| `ANTHROPIC_BEDROCK_BASE_URL` | — | Internal Bedrock gateway URL. If set with `ANTHROPIC_AUTH_TOKEN`, Bedrock mode is used. |
| `ANTHROPIC_AUTH_TOKEN` | — | Auth token for the Bedrock gateway. |
| `ANTHROPIC_API_KEY` | — | Direct Anthropic API key. Used only if Bedrock vars are not both set. |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama base URL for embeddings. |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Ollama model — must produce 768-dim vectors. |
| `WORKER_API_KEY` (Heroku side) | — | Optional — if unset, every `/api/*` route returns 401 and logs a warning (`src/index.ts:47-50`). `/health` still works. |
| `ERROR_SLACK_CHANNEL_ID` | — | Slack channel for errors via `notifyError`. If unset, errors are logged to console only. |
| `POLL_CHANNEL_IDS` | — | Comma-separated legacy channel IDs to poll (merged with `monitored_channels` table). |
| `PORT` | `3000` | HTTP server port. Heroku sets this automatically. |
| `NODE_ENV` | — | If `production`, Postgres SSL uses `rejectUnauthorized: false` (`src/db/client.ts:5`). |
| `TZ` | — | Recommended `America/Los_Angeles`. Business-hours math uses Luxon with an explicit zone so this is defensive. |
| `HARVEST_ALL` | — | Set to `'1'` to make `prHarvester` re-process all tracked PRs. |
| `USER_MAPPINGS_JSON` | — | JSON map for manual GHE → Slack overrides in `userMapper`. |
| `TEST_PR_URL` | — | Optional PR URL for `testGheConnectivity` to exercise an authenticated fetch. |
| `CHANNEL_ID` | — | Used by `scripts/deleteBotMessages.ts` as the target channel when no CLI arg is given. |

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
| `minimatch` | `ontologyEngine.ts` | Glob matching for `domain_file_mappings`. |
| `ollama` | `embeddingService.ts`, workers | Local embeddings client. |
| `pg` | `src/db/client.ts`, migrate.ts | Postgres. |

Dev deps: `typescript` 5.7, `ts-node` 10.9, `@types/*` for `luxon`, `minimatch`, `node`, `pg`.
