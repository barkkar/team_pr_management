# Proactive multi-team user mapping (channel onboarding bootstrap)

**Status:** Draft — awaiting review
**Date:** 2026-05-04
**Author brainstorm trail:** 8 Q&A rounds; see decision log at bottom.

## 1. Problem

`user_mappings` (GHE login → Slack user ID) was seeded by hand for one team. The
reviewer-suggestion flow (`src/index.ts:505-560`, `worker/prAnalyzer.ts:259-281`)
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
- `resolved` — GHE login found on some host; row also written to `user_mappings`.
- `unresolved` — zero hits across all hosts after ≥1 worker attempt; terminal.
  No retry. The reactive mapper eventually catches these when the user appears
  on a PR.

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
3. *New:* `await enqueueChannelBootstrap(channelId, app.client)`.
   `ack()` has already run (Bolt's default at the top of the handler), so
   the 3-second deadline is not at risk. The `respond` call that follows
   (step 4) is the Slack `response_url` webhook, which has no such
   deadline. On throw: catch locally and fall through to the degraded reply
   in step 4; also `notifyError('ChannelBootstrap', msg, 'error')`.
4. Reply (replaces the existing `respond(...)` call):
   - On success: `"✅ This channel is now being monitored for PR review requests. I'll track PRs and send reminders when they need reviews. Queued N member(s) for reviewer mapping."`
   - On enqueue failure: `"✅ This channel is now being monitored for PR review requests. (Member bootstrap failed — will retry when members post PRs.)"`
     The channel is still monitored; reactive mapping still works.
5. If `addMonitoredChannel` returns `false` (channel was already monitored),
   still run step 3 — treat `/pr-monitor add` as a resync. Row-level
   `ON CONFLICT DO NOTHING` keeps this safe.

**`enqueueChannelBootstrap(channelId, slackClient)` implementation:**

1. `conversations.members`, paginate via `cursor` until exhausted.
2. For each returned ID, `users.info`. Skip if `is_bot || deleted`.
3. Read `user.profile.email`. If missing/empty, skip (no queue row).
4. Bulk insert remaining into `channel_bootstrap_members`
   with `status='pending'`, `ON CONFLICT (channel_id, slack_user_id) DO NOTHING`.
5. Return `{queued: <insertedCount>}`.

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

1. `GET ${HEROKU_API_URL}/api/bootstrap-pending?limit=50` (with
   `X-Worker-API-Key`). Dyno returns up to 50 oldest `pending` rows where
   `attempts < 3`. Worker processes serially.
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
     the batch; processing continues to the next row.
3. `POST ${HEROKU_API_URL}/api/bootstrap-complete` with the batch. Dyno
   updates the queue rows and calls `upsertUserMapping` for each resolved
   row in a single transaction.
4. **Pacing.** GHE search rate limit is 30 req/min **per authenticated
   token**. Each host has its own token (and thus its own budget) via
   `GHE_TOKENS`, so host-iteration within a single member does not compound.
   The bottleneck is the slowest host being hit 30 times/min. `await
   sleep(2100)` between members gives ≤29 search calls/min per host, with
   slack for the confirmation `GET /users/<login>` call on the hit path.
   Matches the `setTimeout(resolve, 200)` pattern in
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
  - `getPendingBootstrap(limit)` — `SELECT ... WHERE status='pending' AND attempts < 3 ORDER BY enqueued_at ASC LIMIT $1`.
  - `updateBootstrapResults(results)` — uses an explicit `pool.connect()` client and wraps the queue-row updates **and** the `user_mappings` upserts in a single `BEGIN/COMMIT`. On any failure, `ROLLBACK` and re-throw so the worker retries the whole batch.
- **`src/app.ts`** — import `enqueueChannelBootstrap`; call it inside the `add` case after `addMonitoredChannel`. Add `app.event('member_joined_channel', ...)` handler.
- **`src/index.ts`** — two new endpoints, both guarded by `validateApiKey`:
  - `GET /api/bootstrap-pending?limit=<n>` → `{rows: [{id, channel_id, slack_user_id, email}]}`.
  - `POST /api/bootstrap-complete` → body `{results: [...]}`, 200 on success.
- **`worker/localPRChecker.ts`** — one new call between `runPRStatusCheck()` and `runSuggestReviewersLoop()`, wrapped in its own try/catch.

### Interface contracts

1. `enqueueChannelBootstrap` never makes GHE calls. Runnable from the dyno, which has no VPN.
2. Worker drain never makes Slack calls. Worker laptop doesn't need `SLACK_BOT_TOKEN` for this feature.
3. `/api/bootstrap-complete` is the only write path from worker to both `channel_bootstrap_members` and `user_mappings`. Mirrors the `/api/pr-reviewers` pattern.
4. `listConfiguredHosts()` insertion order = search priority. Document in the JSDoc.

### What stays unchanged

`user_mappings` schema, `upsertUserMapping`, `getUserMapping`, `formatReviewerMessage`, worker API key mechanism, `channelAccessControl`, `monitored_channels`, reactive `worker/userMapper.ts`.

## 7. Security & privacy

- **New Slack scopes required:** `users:read` and `users:read.email`. The bot currently has `channels:history` / `groups:history` (inferred from `conversations.history` in `src/services/channelPoller.ts`). Confirm both scopes are granted before shipping; degrade gracefully if missing (the enqueue step throws a distinguishable error → fallback reply in §5.1 step 4).
- **Email storage:** writes to the existing `user_mappings.email` column via the existing `upsertUserMapping` path. No new PII surface area.
- **Audit trail:** stdout logs only (matches existing posture in `worker/userMapper.ts`). No dedicated audit table in v1.
- **Channel allowlist** (`channelAccessControl.ts`) continues to gate `/pr-monitor add` and `member_joined_channel`. Channels not in `ALLOWED_CHANNEL_IDS` never reach enqueue.

## 8. Failure & retry behavior

| Failure mode | Behavior |
|---|---|
| `users:read.email` scope missing | Enqueue throws; slash-command reply degrades; channel still monitored. Ops page via `notifyError('ChannelBootstrap', ..., 'error')`. |
| `conversations.members` paginated failure mid-way | Whatever was fetched is enqueued; the failure logs through `notifyError`. Re-running `/pr-monitor add` picks up the missed members. |
| `users.info` returns no email for a member | Silently dropped from enqueue. Reactive mapper catches them later if they post a PR. |
| Worker laptop off VPN | HTTP pull from Heroku fails → `notifyError('ChannelBootstrap', ..., 'warn')`, queue intact. Drains on next successful tick. |
| GHE 429 rate limit on search | Row stays `pending`, `attempts += 1`, `last_error` recorded. After 3 attempts, row ages out (skipped by `attempts < 3` filter). Reactive mapper can still catch. |
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

## 10. Open items

None. All Q&A rounds resolved. If subagent review surfaces issues, this
section will collect them before implementation starts.

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
