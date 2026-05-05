# Proactive multi-team user mapping (channel onboarding bootstrap)

**Status:** Draft — awaiting review
**Date:** 2026-05-04
**Author brainstorm trail:** 8 Q&A rounds; see decision log at bottom.

## 1. Problem

`user_mappings` (GHE login → Slack user ID) was seeded by hand for one team. The
reviewer-suggestion flow (`src/index.ts:506-560`, `worker/prAnalyzer.ts:259-281`)
silently drops any Claude-proposed reviewer who lacks a `slack_user_id`. Expanding
to multiple Slack team channels means most reviewers on a new team will be dropped
until the reactive `worker/userMapper.ts` run eventually sees them on a PR —
hours to days of degraded suggestions.

Goal: when a team is onboarded to a new Slack channel via `/pr-monitor add`,
populate `user_mappings` for that channel's members up front so reviewer
suggestions work from the first PR.

## 2. Scope

**In scope**

- A per-channel bootstrap flow triggered by `/pr-monitor add`.
- An incremental flow for new members joining an already-monitored channel
  (Slack `member_joined_channel` event).
- Reverse-lookup: Slack profile email → GHE login via the GHE search API,
  iterating all hosts configured in `GHE_TOKENS`.
- Writing successful resolutions into the existing `user_mappings` table
  via the existing `upsertUserMapping` path.

**Out of scope**

- Changing anything about how `user_mappings` is read by
  `src/index.ts:521-531` (the filter that drops unmapped users stays as-is).
- Replacing or disabling the existing reactive `worker/userMapper.ts` flow.
  It keeps running and fills gaps for members this bootstrap cannot resolve.
- Supporting GHE hosts not configured in `GHE_TOKENS`.
- Email-domain allowlisting or any other filter beyond "skip bots and
  deleted users."
- Real-time feedback to the onboarding EM beyond a one-line suffix in the
  slash-command reply and the existing `notifyError` channel.
- PII-reduction variants (in-memory-only email, etc.) — emails persist in
  `user_mappings.email` exactly as the reactive path already does.
- Periodic reconciliation of channel membership vs queue. Slack Socket Mode
  does not guarantee event delivery; `member_joined_channel` events
  dropped during disconnects are not replayed. Recovery is manual: EM
  re-runs `/pr-monitor add` to re-enqueue current channel membership
  (idempotent via `ON CONFLICT DO NOTHING`).

## 3. Architecture

Four moving pieces, all following existing patterns. Runtime split preserved:
Heroku dyno does Slack work; VPN worker does GHE work.

```
EM runs /pr-monitor add
      │
      ▼
[Dyno] src/app.ts
  ├── existing allowlist check + addMonitoredChannel
  └── enqueueChannelBootstrap(channelId)
        ├── conversations.members (paginated)
        ├── users.info for each (filter bots/deleted/no-email)
        └── INSERT pending rows into channel_bootstrap_members
                (ON CONFLICT DO NOTHING)
                        │
                        │ (every ~5 min)
                        ▼
[Worker laptop] worker/localPRChecker.ts tick
  ├── existing PR-status poll
  ├── NEW: runBootstrapDrainLoop()
  │     ├── GET /api/bootstrap-pending
  │     ├── for each row:
  │     │     for each host in listConfiguredHosts():
  │     │         GET /search/users?q=<email>+in:email
  │     │         GET /users/<login> to confirm email
  │     └── POST /api/bootstrap-complete
  └── existing runSuggestReviewersLoop()

[Dyno] /api/bootstrap-complete
  ├── UPDATE channel_bootstrap_members set status/attempts/last_error
  └── upsertUserMapping(...) for each resolved row
```

Also triggered by `member_joined_channel`: same enqueue path, single user.

## 4. Data model

### New migration `src/db/migrations/021_create_channel_bootstrap_members.sql`

```sql
CREATE TABLE IF NOT EXISTS channel_bootstrap_members (
  id            SERIAL PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  email         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  claimed_at    TIMESTAMP,
  enqueued_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMP,
  UNIQUE (channel_id, slack_user_id)
);

CREATE INDEX IF NOT EXISTS idx_cbm_status_enqueued
  ON channel_bootstrap_members (status, enqueued_at);
```

**Status values** (text, following the `tracked_prs.pr_state` convention —
no Postgres enum type):

- `pending` — awaiting worker drain.
- `in_progress` — a worker has claimed this row for this tick. Set by the
  fetch endpoint (see §5.3 step 1) using `SELECT ... FOR UPDATE SKIP LOCKED`
  with a single `UPDATE` that sets `status='in_progress'`, `claimed_at=NOW()`.
  Reclaim stale `in_progress` rows older than 15 minutes (worker crashed
  mid-batch) back to `pending` via the same fetch query's `OR` clause.
- `resolved` — GHE login found on some host; row also written to `user_mappings`.
- `unresolved` — zero hits across all hosts after ≥1 worker attempt.
  Not retried by the bootstrap flow. The reactive mapper eventually catches
  these when the user appears on a PR.
- `aged_out` — `attempts >= 3` without a successful resolution. Terminal
  until operator intervention. Distinct from `unresolved` so dashboards can
  query "still being worked" vs "gave up."

**Idempotency.** `UNIQUE (channel_id, slack_user_id)` with
`ON CONFLICT DO NOTHING` on insert means re-running `/pr-monitor add` or
receiving duplicate `member_joined_channel` events is safe. A member in two
monitored channels gets two rows — one per channel — intentional.

**`email` is NOT NULL.** Members without a Slack profile email are dropped at
enqueue time and never enter the queue.

**No schema change to `user_mappings`.** `upsertUserMapping`
(`src/db/client.ts:367-384`) already does `ON CONFLICT (ghe_login) DO UPDATE`
and handles every write in this feature.

**No schema change to `monitored_channels`.** The new table is the queue;
monitored channels stay as-is.

## 5. Control flow

### 5.1 `/pr-monitor add` (dyno, `src/app.ts` extension)

1. Existing allowlist check (`isChannelAllowed`).
2. Existing `conversations.info` + `addMonitoredChannel`.
3. **Immediate reply (synchronous path).** Replace the existing `respond(...)`
   call with:
   `"✅ This channel is now being monitored for PR review requests. Queuing members for reviewer mapping — I'll follow up here with the count."`
   This must happen within ≤1s of `ack()` so the EM does not see a hung
   slash command. Do not `await` Slack-side bootstrap work before this.
4. **Background enqueue + delayed response.** After the immediate reply,
   schedule the bootstrap via `setImmediate(async () => { ... })`. The
   async block:
   - Calls `enqueueChannelBootstrap(channelId, app.client)` (uses the same
     `response_url` via Bolt's `respond` closure — valid for up to 30 min
     and 5 follow-up messages per Slack docs).
   - On success: `respond({ response_type: 'ephemeral', replace_original: false, text: "Queued N member(s) for reviewer mapping." })`.
   - On throw: `respond({ ... text: "Member bootstrap failed — will retry when members post PRs." })` and `notifyError('ChannelBootstrap', msg, 'error')`. The channel is still monitored; reactive mapping still works.
5. Step 4 runs unconditionally — both on first-time add and on re-add.
   `addMonitoredChannel` uses `ON CONFLICT (channel_id) DO UPDATE`
   (`src/db/client.ts:163-172`) and always returns a row, so there is no
   "was it new?" signal to branch on; treat every `/pr-monitor add` as a
   (re)sync. Queue-row `ON CONFLICT DO NOTHING` makes the re-sync a no-op
   for already-queued members. Note: the existing `respond("already being
   monitored")` branch at `src/app.ts:151-153` is dead code today — this
   design does not revive it; the unified reply in step 3 subsumes it.

**`enqueueChannelBootstrap(channelId, slackClient)` implementation:**

1. `conversations.members`, paginate via `cursor` until exhausted → set of member IDs.
2. Fetch the full workspace directory via `users.list` (paginated, Tier 2 ≈20 req/min — one call usually covers up to 200 members per page; pace with `setTimeout(resolve, 200)` between pages per the existing `worker/userMapper.ts:89-131` pattern). Build an in-memory map `{id → {is_bot, deleted, profile.email}}`.
3. Intersect: for each channel member ID, look up the entry in the map. Skip if `is_bot || deleted || !profile.email`.
4. Bulk insert remaining into `channel_bootstrap_members`
   with `status='pending'`, `ON CONFLICT (channel_id, slack_user_id) DO NOTHING`.
5. Return `{queued: <insertedCount>}`.

Rationale for `users.list` over per-member `users.info`: `users.info` is Tier 4 (~100/min) — a 300-person channel exhausts it. `users.list` returns all active-workspace users in one paginated call, is Tier 2, and already has a caching pattern in `worker/userMapper.ts`. We reuse that pattern (do not share the cache globally — this runs on the dyno, the cache lives on the worker; rebuild per enqueue).

### 5.2 `member_joined_channel` (dyno, new handler in `src/app.ts`)

1. `isChannelAllowed(event.channel)` — ignore if false.
2. Check `monitored_channels.enabled=TRUE` for the channel — ignore if not
   monitored (bot may be present in channels it doesn't monitor).
3. `users.info` on `event.user`. Skip if bot/deleted/no-email.
4. Single-row `INSERT ... ON CONFLICT DO NOTHING`.

No Slack reply. Silent enqueue.

### 5.3 Worker bootstrap drain (`worker/channelBootstrap.ts`)

Wired into `worker/localPRChecker.ts`'s existing tick, between the PR-status
poll and `runSuggestReviewersLoop`. Its own try/catch so failures here do not
block the reviewer loop.

1. `POST ${HEROKU_API_URL}/api/bootstrap-claim` with body `{limit: 50}` (with
   `X-Worker-API-Key`). Dyno atomically claims up to 50 rows in one
   transaction:
   ```sql
   WITH claimed AS (
     SELECT id FROM channel_bootstrap_members
     WHERE (status = 'pending' AND attempts < 3)
        OR (status = 'in_progress' AND claimed_at < NOW() - INTERVAL '15 minutes')
     ORDER BY enqueued_at ASC
     FOR UPDATE SKIP LOCKED
     LIMIT $1
   )
   UPDATE channel_bootstrap_members c
   SET status = 'in_progress', claimed_at = NOW()
   FROM claimed WHERE c.id = claimed.id
   RETURNING c.id, c.channel_id, c.slack_user_id, c.email;
   ```
   `FOR UPDATE SKIP LOCKED` + the single-statement CTE prevents two
   overlapping workers from claiming the same row. Worker processes the
   returned batch serially.
2. For each `{id, channel_id, slack_user_id, email}`:
   - `hosts = listConfiguredHosts()`.
   - For each host in insertion order:
     - `GET https://<host>/api/v3/search/users?q=<urlencoded email>+in:email&per_page=1`,
       header `Authorization: token <requireTokenForHost(host)>`.
     - If `total_count < 1` → continue to next host.
     - Take first item's `login`. Then
       `GET https://<host>/api/v3/users/<login>`.
     - If returned `email` (case-insensitive) matches the searched email →
       record a resolution `{ghe_login: login, email, display_name: name,
       discovered_via: 'bootstrap_search'}` and break out of the host loop.
     - Else → continue to next host (stale-search guard).
     - On HTTP `429` / `403` with rate-limit headers / network error →
       break out of host loop and throw upward so the whole row is marked
       transient-failed (no partial state).
   - If any host resolved → result `{id, status: 'resolved', ghe_login,
     email, display_name}`.
   - If every host returned zero hits → result `{id, status: 'unresolved'}`.
   - On transient error → result `{id, status: 'pending', attempts_delta: 1,
     last_error: <msg>}`. One row's transient failure does **not** abort
     the batch; processing continues to the next row. When the dyno applies
     the result, if the new `attempts` value ≥ 3, it sets `status='aged_out'`
     instead of `pending` (single-statement UPDATE; see §6
     `updateBootstrapResults`).
3. `POST ${HEROKU_API_URL}/api/bootstrap-complete` with the batch. Dyno
   updates the queue rows and calls `upsertUserMapping` for each resolved
   row in a single transaction.
4. **Pacing.** GHE search (`/search/*`) is rate-limited at **30 req/min
   per authenticated user** (GitHub Enterprise Server docs). Critical
   assumption that must be verified before shipping:
   **do all `GHE_TOKENS` entries belong to distinct GHE users, or the same
   service account?** If distinct users → each host has its own 30/min
   budget. If same user → the 30/min budget is shared across all hosts
   regardless of how many tokens are configured, and the pacing below must
   be tightened proportionally.
   Verification: before the first worker tick on a new host, make one test
   `/search/users` call and log `X-RateLimit-Limit` + `X-RateLimit-Remaining`.
   Write those values to stdout so operator can confirm.
   Default pacing (assuming per-user budgets): `await sleep(2100)` between
   members. Gives ≤29 search calls/min against the host with the lowest
   remaining budget. If shared-user is confirmed, double to `4200`.
   The confirmation `GET /users/<login>` call on the hit path draws from
   the core API budget (5000/hr), not search — no additional search-quota
   impact. Rate-limit pattern matches `setTimeout(resolve, 200)` in
   `worker/userMapper.ts:121`.
5. **Signal-to-noise warning.** After a tick, if
   `unresolved / total > 0.5` AND `total >= 4`, call
   `notifyError('ChannelBootstrap', 'High unresolved ratio: X/Y for channel Z', 'warn')`.
   The `total >= 4` guard prevents a 1-of-2 miss from tripping the alert.
6. All catches funnel through `notifyError`. Transient → `'warn'`;
   scope/auth → `'error'`; nothing here should be `'fatal'`.

## 6. Module boundaries

### New files

| File | Exports | Depends on |
|---|---|---|
| `src/services/channelBootstrap.ts` | `enqueueChannelBootstrap(channelId, slackClient)` | `@slack/web-api` types, `src/db/client` |
| `worker/channelBootstrap.ts` | `runBootstrapDrainLoop()` + standalone CLI entry | `axios`, `src/utils/gheTokenResolver`, Heroku API |
| `src/db/migrations/021_create_channel_bootstrap_members.sql` | — | — |

### Extensions

- **`src/utils/gheTokenResolver.ts`** — add `export function listConfiguredHosts(): string[]`. Returns keys of the internal token map, in insertion order (which is also the search-priority order).
- **`src/db/client.ts`** — add:
  - `insertBootstrapMembers(rows)` — bulk insert with `ON CONFLICT DO NOTHING`, returns inserted count.
  - `claimPendingBootstrap(limit)` — executes the single-CTE `FOR UPDATE SKIP LOCKED` claim query from §5.3 step 1. Returns the claimed rows.
  - `upsertUserMappingTx(client, mapping)` — **new** variant of the existing `upsertUserMapping` that takes an explicit `PoolClient` rather than using the module-level `pool`. Inlines the same SQL as the existing function (`src/db/client.ts:367-384`) so the upsert participates in a caller's transaction. The existing `upsertUserMapping` stays as-is for the reactive path (`worker/userMapper.ts` → `/api/user-mappings`), which doesn't need transactional semantics.
  - `updateBootstrapResults(results)` — checks out a client via `pool.connect()`, issues `BEGIN`, applies queue-row updates **and** calls `upsertUserMappingTx(client, ...)` for resolved rows on the same client. Queue-row update sets `status='aged_out'` when the resulting `attempts >= 3` (see §5.3). `COMMIT` on success; `ROLLBACK` + re-throw on any failure. Without `upsertUserMappingTx`, the existing `upsertUserMapping` would pull a different connection from the pool and run outside the transaction — so this helper is required for the atomicity claim to hold.
- **`src/app.ts`** — import `enqueueChannelBootstrap`; call it inside the `add` case after `addMonitoredChannel`. Add `app.event('member_joined_channel', ...)` handler.
- **`src/index.ts`** — two new endpoints, both guarded by `validateApiKey`:
  - `POST /api/bootstrap-claim` → body `{limit: <n>}`; returns `{rows: [{id, channel_id, slack_user_id, email}]}` after atomically transitioning those rows to `status='in_progress'` with `claimed_at=NOW()`. `POST` (not `GET`) because this endpoint has side effects.
  - `POST /api/bootstrap-complete` → body `{results: [...]}`, 200 on success. Calls `updateBootstrapResults`.
- **`worker/localPRChecker.ts`** — one new call between `runPRStatusCheck()` and `runSuggestReviewersLoop()`, wrapped in its own try/catch.

### Interface contracts

1. `enqueueChannelBootstrap` never makes GHE calls. Runnable from the dyno, which has no VPN.
2. Worker drain never makes Slack calls. Worker laptop doesn't need `SLACK_BOT_TOKEN` for this feature.
3. `/api/bootstrap-complete` is the only write path from worker to both `channel_bootstrap_members` and `user_mappings`. Mirrors the `/api/pr-reviewers` pattern.
4. `listConfiguredHosts()` insertion order = search priority. Document in the JSDoc.

### What stays unchanged

`user_mappings` schema, `upsertUserMapping`, `getUserMapping`, `formatReviewerMessage`, worker API key mechanism, `channelAccessControl`, `monitored_channels`, reactive `worker/userMapper.ts`.

## 7. Security & privacy

- **Slack scopes.** This feature needs `users:read`, `users:read.email`, and
  either `channels:read` (public channels) or `groups:read` (private) for
  `conversations.members` and `member_joined_channel`. **Before implementation, verify the
  currently-granted scope list** by running
  `curl -X POST https://slack.com/api/auth.test -H "Authorization: Bearer $SLACK_BOT_TOKEN"`
  and inspecting the bot token's scopes via `apps.permissions.info`
  (or reviewing the app manifest directly in the Slack admin UI). The
  existing reactive mapper already calls `users.lookupByEmail` and
  `users.list` (`worker/userMapper.ts:68, 102`), so `users:read.email` /
  `users:read` may already be granted — confirm rather than assume.
  If any required scope is missing, either (a) request the scope from the
  Slack admin and hold this feature until granted, or (b) ship with the
  enqueue path degrading gracefully (throws a distinguishable error →
  fallback reply in §5.1 step 4).
- **Event subscriptions.** `member_joined_channel` only fires if the event
  is in the app manifest's `settings.event_subscriptions.bot_events` list.
  Socket Mode does not deliver unsubscribed events. Update the manifest as
  part of the rollout. Document the manifest change in the PR description.
- **Email storage.** Writes to the existing `user_mappings.email` column
  via the existing upsert path. No new PII surface area.
- **Audit trail.** Stdout logs only (matches existing posture in
  `worker/userMapper.ts`). No dedicated audit table in v1.
- **Channel allowlist** (`channelAccessControl.ts`) continues to gate
  `/pr-monitor add` and `member_joined_channel`. Channels not in
  `ALLOWED_CHANNEL_IDS` never reach enqueue.

## 8. Failure & retry behavior

| Failure mode | Behavior |
|---|---|
| `users:read.email` scope missing | Enqueue throws; slash-command reply degrades; channel still monitored. Ops page via `notifyError('ChannelBootstrap', ..., 'error')`. |
| `conversations.members` paginated failure mid-way | Whatever was fetched is enqueued; the failure logs through `notifyError`. Re-running `/pr-monitor add` picks up the missed members. |
| `users.info` returns no email for a member | Silently dropped from enqueue. Reactive mapper catches them later if they post a PR. |
| Worker laptop off VPN | HTTP pull from Heroku fails → `notifyError('ChannelBootstrap', ..., 'warn')`, queue intact. Drains on next successful tick. |
| GHE 429 rate limit on search | Row stays `pending`, `attempts += 1`, `last_error` recorded. After 3 attempts, row transitions to `aged_out` (terminal). Reactive mapper can still catch. |
| Worker claims batch, then crashes mid-processing | Rows stuck in `in_progress`. The next claim query reclaims any `in_progress` row with `claimed_at < NOW() - INTERVAL '15 minutes'` back to the workable set (§5.3 step 1 query). |
| Two workers run simultaneously (laptops, overlapping ticks) | `FOR UPDATE SKIP LOCKED` in the claim query ensures no row is claimed twice. Design assumption is still "one worker laptop"; this is belt-and-suspenders. |
| Slack Socket Mode disconnect drops a `member_joined_channel` event | Event is lost — Slack does not replay. Recovery is manual: EM re-runs `/pr-monitor add` to re-enqueue current channel membership. Explicitly *not* solved by this design; see §2 Out-of-scope. |
| GHE search returns stale login (email mismatch on `/users/<login>`) | Treated as zero hits for that host. If no other host resolves → `unresolved`. |
| GHE host reachable but `GHE_TOKENS` has no entry | `requireTokenForHost` throws; caught in drain loop and logged. That member's row stays `pending`. Admin must fix config. |
| Member joins channel bot isn't in | Slack won't fire the event to us. No action needed. |
| `>50%` of a batch comes back unresolved (and batch ≥ 4) | One `notifyError(..., 'warn')`. Does not stop processing. |

## 9. Verification plan

The repo has no test framework installed (no `jest`/`vitest` in
`package.json`; no `*.test.ts` files). Verification follows the existing
pattern: standalone `ts-node` scripts (like `worker/testSuggestReviewers.ts`)
plus manual checks. Adding a test framework is out of scope for this feature.

### Manual verification scripts (new)

1. **`scripts/testListConfiguredHosts.ts`** — prints the output of
   `listConfiguredHosts()` for visual inspection against the current
   `GHE_TOKENS` env var. Runnable via `npx ts-node`.
2. **`scripts/testChannelBootstrapEnqueue.ts`** — takes a Slack channel ID
   as arg, calls `enqueueChannelBootstrap` against a test channel in a
   throwaway workspace, prints inserted row count + the rows themselves via
   a post-insert `SELECT`. Requires `SLACK_BOT_TOKEN` and DB access.
3. **`worker/channelBootstrap.ts` CLI entry** — same shape as
   `worker/prAnalyzer.ts`'s CLI: `npx ts-node worker/channelBootstrap.ts`
   drains one batch against the dyno API pointed to by `HEROKU_API_URL`.
   Prints per-row outcomes.

### Integration walk-through (documented in the PR description)

Run in this order against a disposable Slack channel + the staging Heroku:

1. `/pr-monitor add` in the test channel → verify:
   - New row in `monitored_channels`.
   - `N > 0` rows in `channel_bootstrap_members` with `status='pending'`.
   - Slash-command reply includes `"Queued N member(s)..."`.
2. Run `npx ts-node worker/channelBootstrap.ts` → verify:
   - Pending rows transition to `resolved` or `unresolved`.
   - Resolved rows have matching entries in `user_mappings` with
     `discovered_via='bootstrap_search'`.
3. Invite a new human to the channel → verify `member_joined_channel`
   handler inserts one new pending row.
4. Run `npm run test-suggest-reviewers -- <pr-url>` against a PR whose
   author or file-touchers are now mapped → verify the Slack reply uses
   `<@U...>` mentions, not `` `ghe-login` `` fallbacks. **This is the real
   acceptance check** — the whole feature exists to make this succeed.

### House-rules alignment

- CLAUDE.md: "a change is complete only after… the worker loop to exercise." The integration walk-through covers both the Socket Mode path (slash command, join event) and the worker loop.
- Migration convention: 021 is the next sequential prefix; immutable once merged.

## 10. Open items (must resolve before implementation plan is written)

1. **`GHE_TOKENS` ownership model.** Confirm whether each host's token
   belongs to a distinct GHE user or the same service account. Determines
   whether the 30 req/min search budget is per-host or shared. See §5.3
   step 4. One-time check against staging is sufficient.
2. **Current Slack scope list.** Run `auth.test` (or inspect the manifest)
   and paste the result into the PR description before implementation.
   See §7.
3. **Event-subscription manifest update.** `member_joined_channel` must be
   added to the manifest's `bot_events` list as part of this feature's
   rollout. Coordinate with the Slack admin.
4. **Worker deployment model.** Confirm "one worker laptop at a time" is
   the intended model. The `FOR UPDATE SKIP LOCKED` claim step works for
   multi-worker setups too, but the pacing math in §5.3 step 4 assumes
   a single worker per token-owner.

## 11. Decision log

| Q | Choice | Consequence |
|---|---|---|
| 1 | Trigger = `/pr-monitor add` | No new slash command; onboarding moment becomes bootstrap moment. |
| 2 | Queue-and-worker split | ≤5 min lag; matches dyno/worker runtime boundary exactly. |
| 3 | Skip bots/deleted; persist only resolved | No schema change to `user_mappings`; no dead rows. |
| 4 | GHE search API only | 30 req/min budget assumed; stale-search guard via `/users/<login>` confirm. |
| 5 | Iterate all hosts in `GHE_TOKENS` | Need `listConfiguredHosts()` helper; per-member call count ≤ number of hosts. |
| 6 | Idempotent add + `member_joined_channel` listener | One new Slack event handler; best coverage over time. |
| 7 | Add scopes, persist emails, stdout logs | No new audit table; matches existing PII posture. |
| 8 | `notifyError` on high unresolved ratio (>50% with batch ≥4) | Signal-to-noise protected; single misses silent. |
