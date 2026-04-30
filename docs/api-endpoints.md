# HTTP API endpoints

Every route is served by the single HTTP server created in `src/index.ts:336`. The server runs inside the Heroku dyno, alongside the Slack Bolt Socket Mode app.

**Auth**: all `/api/*` routes require the `X-Worker-API-Key` header to match `WORKER_API_KEY`. `Authorization: Bearer <token>` is also accepted (`src/index.ts:44`). `/health` and `/` are public. If `WORKER_API_KEY` is unset the API is effectively disabled (401 on every call — see `src/index.ts:47-50`).

**CORS**: wide-open `Access-Control-Allow-Origin: *` with `GET, POST, OPTIONS` and `Content-Type, X-Worker-API-Key, Authorization` header allowlist (`src/index.ts:341-343`).

**Error handling**: unhandled errors return 500 with `{ error }` and call `notifyError('HTTPServer', ...)`.

## Health

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Same as `/health` |
| GET | `/health` | Returns `{status: 'ok', app: 'pr-review-reminder'}` |

## Worker status sync

| Method | Path | Body / Query | Purpose |
|---|---|---|---|
| GET | `/api/pending-prs` | — | PRs needing a GHE status check. Used by `localPRChecker`. |
| POST | `/api/pr-status` | `{results: [{pr_url, is_open, has_reviews}]}` | Worker reports GHE check results. Updates `tracked_prs`. |

## Harvest — PR data

| Method | Path | Body / Query | Purpose |
|---|---|---|---|
| GET | `/api/tracked-prs-for-harvest` | — | Tracked PRs not yet in `pr_reviews`. Used by `prHarvester` incremental mode. |
| GET | `/api/all-tracked-prs` | — | Every tracked PR (for `HARVEST_ALL=1` re-harvest). |
| GET | `/api/distinct-repos` | — | Distinct `{org, repo, hostname}` from `tracked_prs`. Used by `repoHarvester`. |
| GET | `/api/harvest-state?org=...&repo=...` | — | Returns `{state}` for `harvest_state`. |
| POST | `/api/harvest-data` | `{reviews[], files[], harvest_state?}` | `prHarvester` uploads review comments + file rows. |
| POST | `/api/repo-knowledge` | `{chunks[], harvest_state?}` | `repoHarvester` uploads chunked source code. |
| POST | `/api/user-mappings` | `{mappings[]}` | `userMapper` upserts GHE↔Slack mappings. |
| GET | `/api/domain-file-mappings` | — | Ordered by `priority DESC`; used by `repoHarvester` to assign `domain_id` per chunk. |

## Analysis lifecycle

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/api/prs-needing-analysis` | — | Tracked PRs from last 24h that have no `pr_analysis_results` row. `LIMIT 10`. |
| POST | `/api/pr-analysis` | `{pr_url, channel_id, message_ts, review, reviewers}` | Worker submits final review. Stored, and posted to Slack as a thread reply when `channel_id !== 'manual'`. |
| POST | `/api/repost-analysis` | `{pr_url, channel_id?, message_ts?}` | Re-posts stored analysis if the first post failed. |
| POST | `/api/suggested-reviewers` | `{file_paths[], pr_author?}` | Two-signal ranker (file reviewers ×2, file authors ×1; caps at 20; Slack-mapped users only). Returns top 5. |
| POST | `/api/domain-code-examples` | `{domain_ids, changed_files, org?, repo?, element_types?, limit?=5, max_per_file?=1}` | Test endpoint for `fetchDomainScopedCodeExamples`. |

## Feedback + learning

| Method | Path | Body / Query | Purpose |
|---|---|---|---|
| POST | `/api/ai-feedback` | `{pr_url, user_id, rating, feedback_text?}` | External ingest of feedback (Slack buttons go through the Bolt action handler). |
| GET | `/api/prs-needing-lessons` | — | Closed PRs with AI review but no lessons. |
| POST | `/api/ai-lessons` | `{pr_url, ai_review, peer_comments, lessons}` | Store extracted lessons. |
| GET / POST | `/api/ai-learning-context?limit=5` | `limit` via query string only | Accepts GET or POST; returns `{lessons, feedback}` from recency lookup only. `limit` is clamped to 5 (lessons) and 3 (feedback). |
| GET | `/api/closed-prs-without-lessons?limit=50&force=true` | — | `bootstrapLearner` input. `force=true` returns all closed PRs that *do* have `pr_analysis_results`. |

## Ontology

| Method | Path | Body | Purpose |
|---|---|---|---|
| POST | `/api/resolve-rules` | `{changed_files[], diff_text?}` | Deterministic rule resolution. Returns `{rules, taxonomy, unmatched_files}`. |
| GET | `/api/ontology/taxonomy` | — | Full domain tree with rule counts. |
| GET | `/api/ontology/domains` | — | Flat list. |
| POST | `/api/ontology/domains` | `{name, display_name, parent_id?, description?}` | |
| GET | `/api/ontology/rules?domain_id=&team_owner=` | — | Includes disabled rules (no `enabled=true` filter). |
| POST | `/api/ontology/rules` | `{domain_id, rule_key, title, description, severity?='high', team_owner?, matchers?, file_mappings?}` | Creates rule + matchers + domain file mappings in one call. |
| PUT | `/api/ontology/rules/:id` | partial body | Passes body to `updateRule`. |
| DELETE | `/api/ontology/rules/:id` | — | Cascades to `rule_matchers` via `ON DELETE CASCADE`. |
| POST | `/api/ontology/rule-feedback` | `{rule_id, pr_url, user_id, action, feedback_text?}` | One row per event — no uniqueness constraint. |

## Slack interaction (not HTTP — for reference)

These are not `/api/*` routes but Bolt-registered action/view handlers in `src/app.ts`:

- `ai_review_helpful` / `ai_review_not_helpful` (`src/app.ts:381, 425`) — open a feedback modal, then the `ai_review_feedback_modal` view (`src/app.ts:469`) persists the text.
- `comment_helpful` / `comment_not_helpful` (`src/app.ts:491, 504`) — writes to `ai_comment_feedback`, acks with an ephemeral response.
- `/pr-monitor` slash command subcommands: `add`, `remove`, `list`, `pending`, `status`, `stats`, `harvest-status`, `help` (`src/app.ts:111`).
