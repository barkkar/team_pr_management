# Implementation Plan — Proactive multi-team user mapping

**Spec:** `docs/superpowers/specs/2026-05-04-multi-team-user-mapping-design.md`
**Date:** 2026-05-05
**Status:** Draft — revised after parallel review (code-review + repo-audit subagents)

### Review findings applied (2026-05-05)

Two review passes ran in parallel. Explore verified file paths and line
numbers against the current repo; a general-purpose reviewer stress-tested
the design decisions against the spec. Corrections folded into the packets
below:

- **Line numbers** — `/pr-monitor add` block is `src/app.ts:144-155` (not 144-154); `runSuggestReviewersLoop()` is at `worker/localPRChecker.ts:225` (not ~223).
- **`validateApiKey` is private** in `src/index.ts` (defined at line 31, not exported). Packet C2 adds the endpoints in-file, so no export is needed — just reuse the function in the same module.
- **`setImmediate` is not an existing pattern** in this codebase. Packet C4 introduces it deliberately; the rationale and safety net are spelled out there.
- **Transaction path** — instead of duplicating `upsertUserMapping`, Packet B adds an optional `client` parameter to the existing function (see "Contract-adjustment" under Packet B).
- **Slack `users.list` rate limit on the dyno** — Packet C1 adds a short-lived in-memory TTL cache + a single-flight mutex to protect Tier-2 when multiple `/pr-monitor add` calls overlap.
- **`notifyError` throttle key** — unresolved-ratio message is made stable so the built-in 1/min throttle actually catches repeat alerts (Packet C3).
- **Type surface** — `slack_user_id` is folded into `BootstrapResult.resolved` at Packet A, not retro-patched at B.
- **Dropped spec items** — rate-limit-header logging on first-call-per-host (spec §5.3 step 4) and scope-vs-transient error distinction on the enqueue path (spec §7) are now explicit in Packets C3 and C4 respectively.
- **Packet G** — acceptance adds an `aged_out` transition check and a post-deploy `apps.permissions.info` check for `member_joined_channel` delivery.
- **Rollback** — §6 now includes a concrete cleanup query.

This plan sequences the spec into parallelizable work packets. Each packet
lists inputs, outputs, and explicit dependencies so that independent streams
can be picked up concurrently (by humans or parallel Claude sessions).

---

## 0. Pre-flight (blocks everything; do these first, serially)

These are the spec's §10 open items. None of them require code edits but
they *must* be resolved before the implementation lands, because they affect
pacing math, scope hard-dependencies, and deployment model.

| # | Action | Artifact |
|---|---|---|
| 0.1 | Verify `GHE_TOKENS` ownership model — one service account across hosts, or distinct per-host users? Use one `/search/users` call against staging; log `X-RateLimit-Limit` + `X-RateLimit-Remaining` from response headers. | Note in PR description: "per-host budget" or "shared budget"; sets pacing constant. |
| 0.2 | Confirm current Slack bot scopes. `curl -X POST https://slack.com/api/auth.test -H "Authorization: Bearer $SLACK_BOT_TOKEN"` + review manifest in Slack admin. Required: `users:read`, `users:read.email`, `channels:read` OR `groups:read`. | List of granted scopes; any gap becomes a rollout pre-req. |
| 0.3 | Add `member_joined_channel` to app manifest `settings.event_subscriptions.bot_events`. | Manifest diff, captured for PR description. |
| 0.4 | Confirm single-worker deployment ("one laptop at a time"). | Note in PR description — locks in pacing assumptions in 5.3 step 4. |

**Gating rule.** If 0.1 says "shared budget," the pacing constant in Packet
C3 becomes `4200ms` instead of `2100ms`. If 0.2 surfaces a missing scope,
either request it *before* starting Packet A, or plan to ship Packet B's
degrade-path first. Other items don't gate code but must be noted in the
eventual PR.

---

## 1. Dependency graph

```
                 ┌──────────────────────────────────────┐
                 │ 0. Pre-flight (scopes, budget, mani) │
                 └──────────────────┬───────────────────┘
                                    │
        ┌───────────────────────────┴───────────────────────────┐
        │                                                       │
        ▼                                                       ▼
 ┌──────────────┐     ┌────────────────────────┐      ┌────────────────────┐
 │ A. Migration │     │ D1. listConfiguredHosts │     │ E1. Scripts:       │
 │ 021 + types  │     │ helper (utils)          │     │ testListHosts      │
 └──────┬───────┘     └───────┬────────────────┘      └──────────┬─────────┘
        │                     │                                  │
        ▼                     │                                  │
 ┌──────────────┐              │                                  │
 │ B. db/client │              │                                  │
 │ helpers      │              │                                  │
 │ (insertBoot, │              │                                  │
 │  claim,      │              │                                  │
 │  upsertTx,   │              │                                  │
 │  updateRes)  │              │                                  │
 └──┬────────┬──┘              │                                  │
    │        │                 │                                  │
    ▼        ▼                 ▼                                  │
 ┌──────┐ ┌─────────────┐  ┌────────────────────┐                 │
 │ C1.  │ │ C2. Dyno API│  │ C3. Worker drain   │                 │
 │ Dyno │ │ endpoints   │  │ loop               │                 │
 │ svc  │ │ /bootstrap- │  │ worker/channel     │                 │
 │ enq  │ │ claim,      │  │ Bootstrap.ts       │                 │
 │ eue  │ │ /bootstrap- │  │ (uses D1)          │                 │
 │      │ │ complete    │  │                    │                 │
 └──┬───┘ └──────┬──────┘  └──────────┬─────────┘                 │
    │            │                    │                            │
    ▼            ▼                    ▼                            ▼
 ┌────────────────────────────────────────────────────────┐  ┌─────────┐
 │ C4. app.ts wiring:                                     │  │ E2/E3.  │
 │   - /pr-monitor add → enqueue                          │  │ Manual  │
 │   - member_joined_channel handler                      │  │ test    │
 └──────────────────────┬─────────────────────────────────┘  │ scripts │
                        │                                    └────┬────┘
                        ▼                                         │
         ┌────────────────────────────┐                           │
         │ F. Worker loop wiring:     │◀──────────────────────────┘
         │ localPRChecker inserts     │
         │ runBootstrapDrainLoop()    │
         └─────────────┬──────────────┘
                       │
                       ▼
         ┌────────────────────────────┐
         │ G. Integration walk-through│
         │ on staging                 │
         └────────────────────────────┘
```

Legend: boxes on the same row have no interdependencies → can be executed in
parallel.

---

## 2. Parallelization analysis

### What can actually run in parallel

| Parallel group | Packets | Reason |
|---|---|---|
| **P1 — Foundations** | A, D1, E1 | Migration SQL, hostname helper, and host-listing script touch disjoint files and don't import from each other. |
| **P2 — Features on B** | C1, C2, C3 | All three consume the same `db/client.ts` helpers (B) but produce independent modules: a dyno service, two HTTP endpoints, and a worker file. Types defined in A need to be importable by all three — see §3 "Shared type surface." **Note on C3 testability:** C3 can be *authored* in parallel with C2, but its integration-test scope (the standalone `npx ts-node worker/channelBootstrap.ts` CLI) depends on `/api/bootstrap-claim` and `/api/bootstrap-complete` existing. Until C2 lands, C3's acceptance is limited to unit-style verification (mock the HTTP calls or assert the payload shape). The dependency graph above shows them as parallel because of file disjointness; they are not parallel on end-to-end testing. |
| **P3 — Test scripts** | E2, E3 | Both live in `scripts/` and are runnable without the wiring. E2 needs C1 landed; E3 needs C3 landed — so this group parallelizes *after* P2 starts. |

### What must be serial

- **A → B**: `db/client.ts` helpers need the table type in scope. The type
  interface can be moved into A to break this.
- **B → C1, C2, C3**: all three call the new DB helpers.
- **C1 + C2 + C3 → C4**: the Slack handlers import from the dyno service
  (`enqueueChannelBootstrap`) and indirectly trust the API endpoints.
- **C2 + C3 + C4 → F**: wiring into `localPRChecker.ts` assumes the drain
  loop and endpoints exist.
- **Everything → G**: integration walk-through needs the full loop.

### Suggested concurrency

With one engineer: Pre-flight → P1 serial → B → P2 in parallel → C4 → F → G.
With three engineers or parallel Claude sessions: P1 parallel; B; then three
people take C1/C2/C3 concurrently; they resync on C4; one person lands F
and G.

**Hard merge-order rule.** Even with parallel work, commits must land in
topological order — B before any C-packet; C4 before F — because the Socket
Mode handler hard-fails at startup if imports don't resolve. Use one shared
feature branch, rebase individual packets before merge.

---

## 3. Shared type surface (define once, import everywhere)

To avoid accidental divergence between the dyno and worker, add a new file
`src/types/channelBootstrap.ts` in Packet A. Everything else imports from
here.

```ts
// src/types/channelBootstrap.ts
export type BootstrapStatus =
  | 'pending'
  | 'in_progress'
  | 'resolved'
  | 'unresolved'
  | 'aged_out';

export interface BootstrapMemberRow {
  id: number;
  channel_id: string;
  slack_user_id: string;
  email: string;
  status: BootstrapStatus;
  attempts: number;
  last_error: string | null;
  claimed_at: Date | null;
  enqueued_at: Date;
  resolved_at: Date | null;
}

export interface BootstrapClaim {
  id: number;
  channel_id: string;
  slack_user_id: string;
  email: string;
}

export type BootstrapResult =
  | {
      id: number;
      status: 'resolved';
      ghe_login: string;
      email: string;
      display_name: string | null;
      slack_user_id: string; // threaded through from BootstrapClaim; needed for upsertUserMapping
    }
  | { id: number; status: 'unresolved' }
  | { id: number; status: 'pending'; attempts_delta: 1; last_error: string };
```

The wire contract for `/api/bootstrap-claim` and `/api/bootstrap-complete`
uses `BootstrapClaim[]` and `BootstrapResult[]` respectively. `slack_user_id`
lives on the `resolved` variant so the dyno's `updateBootstrapResults` can
write to `user_mappings` without a re-query; the worker already knows the
value from the claim payload.

---

## 4. Packets

### Packet A — Migration 021 + shared types

**Files:**
- `src/db/migrations/021_create_channel_bootstrap_members.sql` (new)
- `src/types/channelBootstrap.ts` (new)

**Steps:**
1. Copy the SQL from spec §4 verbatim into the migration file.
2. Write the types file per §3 above.
3. Local sanity check: `npm run migrate` against a throwaway DB; confirm
   the table + index + unique constraint exist.
4. Unit of acceptance: `npm run compile` passes with the new types imported
   from a scratch file; `schema_migrations` has row `021_*`.

**Dependencies:** none (after pre-flight).
**Parallel with:** D1, E1.

---

### Packet B — `db/client.ts` helpers

**Files:**
- `src/db/client.ts` (extend)

**New exports (spec §6, revised):**
1. `insertBootstrapMembers(rows: {channel_id: string; slack_user_id: string; email: string}[]): Promise<number>`
   - Builds a single `INSERT ... VALUES ($1,$2,$3), ... ON CONFLICT (channel_id, slack_user_id) DO NOTHING`.
   - Returns `result.rowCount` (number of freshly inserted rows).
2. `claimPendingBootstrap(limit: number): Promise<BootstrapClaim[]>`
   - Executes the exact single-statement CTE from spec §5.3 step 1
     (with `FOR UPDATE SKIP LOCKED` + 15-min reclaim).
3. `updateBootstrapResults(results: BootstrapResult[]): Promise<void>`
   - Acquires a `PoolClient` via `pool.connect()`.
   - `BEGIN`.
   - For each result:
     - `resolved` → `UPDATE channel_bootstrap_members SET status='resolved', resolved_at=NOW() WHERE id=$1`, then `upsertUserMapping({ghe_login, slack_user_id, display_name, email, discovered_via: 'bootstrap_search'}, client)` (see refactor below).
     - `unresolved` → `UPDATE ... SET status='unresolved', resolved_at=NOW()`.
     - `pending` → `UPDATE ... SET attempts = attempts + 1, last_error=$2, claimed_at=NULL, status = CASE WHEN attempts + 1 >= 3 THEN 'aged_out' ELSE 'pending' END`.
   - `COMMIT` on success; `ROLLBACK` + rethrow on error.
   - Always `client.release()` in `finally`.

**Contract-adjustment: refactor existing `upsertUserMapping` (replaces the earlier `upsertUserMappingTx` plan).**

Current signature (`src/db/client.ts:367`):
```ts
export async function upsertUserMapping(mapping: Omit<UserMapping, 'id' | 'updated_at'>): Promise<UserMapping | null>
```

New signature:
```ts
export async function upsertUserMapping(
  mapping: Omit<UserMapping, 'id' | 'updated_at'>,
  client: Pool | PoolClient = pool,
): Promise<UserMapping | null>
```

`node-postgres` exposes `.query()` on both `Pool` and `PoolClient`, so the
function body stays identical — the only change is `pool.query(...)` →
`client.query(...)`. Existing callers (reactive mapper via `src/index.ts`
`/api/user-mappings`) don't pass `client`, get the default, and observe
zero behavior change. `updateBootstrapResults` passes its active `PoolClient`
so the user-mapping write participates in the same transaction.

Rationale: a reviewer flagged that duplicating the SQL into `upsertUserMappingTx`
introduces two sources of truth that will drift. A single parameterized
function is cleaner and covers the atomicity requirement equally well.

**Dependencies:** A.
**Parallel with:** nothing (everything downstream needs these).

---

### Packet C1 — Dyno enqueue service

**Files:**
- `src/services/channelBootstrap.ts` (new)

**Export:** `enqueueChannelBootstrap(channelId: string, slackClient: WebClient): Promise<{ queued: number }>`

**Implementation:** spec §5.1 "`enqueueChannelBootstrap` implementation" 1-5.

Key details:
- Page through `conversations.members` with `cursor` until exhausted. Build a `Set<string>` of member IDs.
- Page through `users.list` (limit 200) with the same `setTimeout(resolve, 200)` pacing used in `worker/userMapper.ts:121`.
- Build a `Map<string, {is_bot, deleted, email}>` from `users.list`. Filter: `is_bot || deleted || !profile.email` → drop.
- Intersect. Build array of `{channel_id, slack_user_id, email}` rows.
- Call `insertBootstrapMembers(rows)` from Packet B.
- Return `{queued: insertedCount}`.

**Rate-limit protection (added after review).** Slack `users.list` is Tier-2
(~20 req/min). The reactive worker caches the result on the laptop; the dyno
has no such cache and `/pr-monitor add` can be invoked back-to-back for
several channels. Without protection, a burst of three or four additions
would trip the limit. Mitigations in this module:

1. **Module-level TTL cache for `users.list`**, keyed by nothing (workspace
   directory is global). TTL = 5 minutes. Shape:
   ```ts
   let usersListCache: { fetchedAt: number; users: Map<string, {...}> } | null = null;
   const USERS_LIST_TTL_MS = 5 * 60 * 1000;
   ```
   Pre-check cache freshness before paginating; if fresh, reuse.
2. **Single-flight mutex** so two concurrent `/pr-monitor add` calls don't
   both cold-fetch `users.list`:
   ```ts
   let inflight: Promise<Map<string, ...>> | null = null;
   async function getUsersDirectory(client) {
     if (cache-is-fresh) return cached;
     if (inflight) return inflight;
     inflight = fetchUsersListPaginated(client).finally(() => { inflight = null; });
     return inflight;
   }
   ```
3. `conversations.members` is channel-scoped and cannot be cached the same
   way. For a 300-member channel it's one or two `limit=1000` calls — fine
   at Tier-3.

The cache is invalidated naturally on TTL expiry; no explicit invalidation
is needed because newly added Slack workspace members are picked up by the
next `users.list` fetch (worst-case 5-minute lag), and the reactive mapper
catches anyone truly missed.

**Error handling:** throws on Slack API error; caller (`src/app.ts`) wraps
the throw and routes through `notifyError('ChannelBootstrap', msg, 'error')`.
Distinguish scope errors (`missing_scope`) from transient errors — see
Packet C4 for the differentiated fallback reply.

**Dependencies:** B.
**Parallel with:** C2, C3.

---

### Packet C2 — Dyno HTTP endpoints

**Files:**
- `src/index.ts` (extend — add two handlers to the existing HTTP switch)

**New endpoints (both `validateApiKey`-guarded):**

1. `POST /api/bootstrap-claim`
   - Body: `{limit: number}` (max 50, default 50, validate numeric).
   - Calls `claimPendingBootstrap(limit)`.
   - Returns `{rows: BootstrapClaim[]}` with HTTP 200.

2. `POST /api/bootstrap-complete`
   - Body: `{results: BootstrapResult[]}`.
   - Validates each result has an `id` and a known `status`.
   - Calls `updateBootstrapResults(results)`.
   - Returns `{ok: true, updated: results.length}`.

**Where to add:** follow the existing pattern in `src/index.ts` — the
switch over `req.method` + `req.url` (around line 140+). Group with other
worker-side endpoints (`/api/pr-status`, `/api/user-mappings`, etc.).

Note: `validateApiKey` is defined privately at `src/index.ts:31` and is not
exported. Since the new endpoints live in the same file, they reuse it
directly — no export change needed.

**Logging:** per-call, log `[bootstrap-claim] returned N rows` and
`[bootstrap-complete] applied N results (K resolved, K unresolved, K pending)`.

**Dependencies:** B.
**Parallel with:** C1, C3.

---

### Packet C3 — Worker drain loop

**Files:**
- `worker/channelBootstrap.ts` (new)

**Exports:**
- `export async function runBootstrapDrainLoop(): Promise<void>`
- CLI entry (mirror `worker/prAnalyzer.ts` shape): when run directly via
  `npx ts-node worker/channelBootstrap.ts`, drain one batch and exit.

**Implementation:** spec §5.3 steps 1-6.

Key details:
- `POST /api/bootstrap-claim` with `{limit: 50}`, parse `rows`.
- If `rows.length === 0`, log and return.
- **Rate-limit header probe (spec §5.3 step 4, line 253-255).** On the first
  `/search/users` call to a host *in a given tick*, log
  `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` to
  stdout. Keep a per-tick `Set<string>` of hosts already probed. This lets
  the operator confirm whether the 30/min budget is per-host or shared
  (pre-flight 0.1).
- Per row:
  - `hosts = listConfiguredHosts()` (Packet D1).
  - For each host in order:
    - `GET https://<host>/api/v3/search/users?q=<encoded email>+in:email&per_page=1`, headers `Authorization: token <requireTokenForHost(host)>`.
    - If `total_count < 1` → continue.
    - `GET https://<host>/api/v3/users/<login>` to confirm email (case-insensitive).
    - On match: build `{id, status: 'resolved', ghe_login, email, display_name, slack_user_id}`; break.
    - On 429 / 403 rate-limit / network error → **catch within the host loop**, mark this row as transient (`pending` with `attempts_delta: 1`), **break host loop**, continue to next row.
- **Deliberate deviation from spec §5.3 step 2 line 232.** The spec says
  "throw upward" on transient error; this plan catches within the batch so
  one member's transient failure doesn't abort processing of the other 49.
  Spec §5.3 step 2's own subsequent text ("One row's transient failure does
  **not** abort the batch") confirms the catch-and-continue behavior is the
  intent; the word "throw" on the earlier line is a spec inconsistency.
  Flag this in the PR description.
  - If all hosts returned zero → `unresolved`.
- **Pacing:** `await sleep(PACE_MS)` between rows. `PACE_MS = 2100` if pre-flight 0.1 confirms per-host budgets; else `4200`. Define as a module-level `const PACE_MS` that reads from `process.env.CHANNEL_BOOTSTRAP_PACE_MS` with the 2100 default, so the value can be tuned without redeploying.
- **Unresolved-ratio alert.** After processing, compute `unresolved_count / rows.length`. If ratio > 0.5 AND `rows.length >= 4`, call:
  ```ts
  notifyError('ChannelBootstrap', 'High unresolved ratio on bootstrap drain', 'warn');
  log(`[ChannelBootstrap] unresolved=${unresolvedCount}/${rows.length} channels=${[...new Set(rows.map(r => r.channel_id))].join(',')}`);
  ```
  The notify message is stable (no numbers) so `notifyError`'s built-in
  `source+message` 1/min throttle actually catches repeat alerts across
  successive ticks. The varying numeric detail is logged separately.
- `POST /api/bootstrap-complete` with the `results` array.
- Log per-row outcome.

**Error handling (top-level):** wrap the entire loop in try/catch; any
uncaught → `notifyError('ChannelBootstrap', ..., 'warn')` (spec §5.3 step 6).

**Dependencies:** B, D1.
**Parallel with:** C1, C2.

---

### Packet C4 — `src/app.ts` wiring

**Files:**
- `src/app.ts` (extend)

**Changes:**

1. **`/pr-monitor add` case** — replace `src/app.ts:144-155` (the full
   `if (added) {...} else {...}` branch) with the block below. Note the
   unified reply intentionally subsumes the dead "already being monitored"
   branch, matching spec §5.1 step 5.
   ```ts
   const added = await addMonitoredChannel(channelId, channelName, userId);
   // Unified reply — no branching on `added`. See spec §5.1 step 5.
   await respond({
     response_type: 'in_channel',
     text: '✅ This channel is now being monitored for PR review requests. ' +
           "Queuing members for reviewer mapping — I'll follow up here with the count.",
   });

   // setImmediate lets the slash-command ack return <1s. Bolt's `respond`
   // closure wraps Slack's signed `response_url`, which is valid for 30 min
   // and 5 follow-ups — ample for a single delayed reply.
   //
   // SAFETY: the outer try/catch is MANDATORY. Any throw that escapes a
   // setImmediate callback is uncaught at the Bolt layer and would crash
   // the dyno process. Do not remove it.
   setImmediate(async () => {
     try {
       const { queued } = await enqueueChannelBootstrap(channelId, client);
       await respond({
         response_type: 'ephemeral',
         replace_original: false,
         text: `Queued ${queued} member(s) for reviewer mapping.`,
       });
     } catch (err: any) {
       // Distinguish scope failures (non-retryable, operator action needed)
       // from transient Slack/DB blips (retryable on next /pr-monitor add).
       const isScopeError =
         err?.data?.error === 'missing_scope' ||
         /missing_scope|not_in_channel|not_authed/.test(String(err?.message || ''));
       const userMessage = isScopeError
         ? 'Member bootstrap skipped — Slack bot is missing required scope. Contact the workspace admin.'
         : 'Member bootstrap failed — will retry when members post PRs.';
       try {
         await respond({
           response_type: 'ephemeral',
           replace_original: false,
           text: userMessage,
         });
       } catch (_respondErr) {
         // response_url may have expired; fall through to notifyError below.
       }
       notifyError(
         'ChannelBootstrap',
         `enqueueChannelBootstrap failed for ${channelId}: ${err.message}`,
         isScopeError ? 'error' : 'warn',
       );
     }
   });
   break;
   ```

   **Enqueue-duration safety.** `enqueueChannelBootstrap` for a very large
   channel pages `conversations.members` + `users.list`; worst-case ~10
   pages at 200ms pacing is ≈2s, well under the 30-min response_url window.
   No hard cap is needed today, but if a future workspace size pushes
   enqueue past ~20 min the follow-up `respond(...)` will 404. The inner
   try/catch above swallows that, so the failure mode is "no follow-up
   reply" rather than a dyno crash.

2. **`member_joined_channel` handler** — new `app.event('member_joined_channel', async ({ event, client }) => {...})`:
   - `isChannelAllowed(event.channel)` → return if false.
   - `isChannelMonitored(event.channel)` → return if false. (Use existing helper from `db/client.ts`.)
   - `client.users.info({ user: event.user })` → skip if `is_bot || deleted || !profile.email`.
   - Call `insertBootstrapMembers([{channel_id, slack_user_id, email}])` directly (skip the full enqueue helper for single-user case).
   - No reply. Silent success. Errors → `notifyError('ChannelBootstrap', ..., 'warn')`.

**Dependencies:** C1 (for `enqueueChannelBootstrap` import), B (for `insertBootstrapMembers` import).
**Parallel with:** nothing — convergence point.

---

### Packet D1 — `listConfiguredHosts` helper

**Files:**
- `src/utils/gheTokenResolver.ts` (extend)

**New export:**
```ts
/**
 * Returns configured GHE hostnames in insertion order.
 * Insertion order = search priority (see design doc §5.3).
 */
export function listConfiguredHosts(): string[] {
  return [...loadTokenMap().keys()];
}
```

Since `loadTokenMap` uses a `Map` (insertion-ordered in JS), `.keys()`
already preserves order. No caching changes needed.

**Dependencies:** none.
**Parallel with:** A, E1.

---

### Packet E1 — `scripts/testListConfiguredHosts.ts`

**Files:**
- `scripts/testListConfiguredHosts.ts` (new)

**Content:** 10-line script that imports `listConfiguredHosts`, prints the
result, exits.

**Dependencies:** D1 (soft — you can stub the import first).
**Parallel with:** A, D1.

---

### Packet E2 — `scripts/testChannelBootstrapEnqueue.ts`

**Files:**
- `scripts/testChannelBootstrapEnqueue.ts` (new)

**Content:** `npx ts-node scripts/testChannelBootstrapEnqueue.ts <channel-id>`:
- Instantiate `WebClient` with `SLACK_BOT_TOKEN`.
- Call `enqueueChannelBootstrap(channelId, slackClient)`.
- Run `SELECT * FROM channel_bootstrap_members WHERE channel_id=$1 ORDER BY enqueued_at DESC LIMIT 50;` via `pool` and print rows.

**Dependencies:** C1.
**Parallel with:** E3 (once their deps are met).

---

### Packet E3 — `worker/channelBootstrap.ts` CLI entry

Already covered by Packet C3 — no separate packet needed.

---

### Packet F — Worker loop wiring

**Files:**
- `worker/localPRChecker.ts` (extend)

**Change:** insert the new call between the PR-status block and the
existing `runSuggestReviewersLoop()` invocation at `worker/localPRChecker.ts:225`
(inside the try/catch block at lines 224-228). Insert immediately before
that try block:

```ts
// Bootstrap drain: fills user_mappings for newly onboarded channel members.
// Isolated try/catch so failures here don't block the reviewer loop.
try {
  const { runBootstrapDrainLoop } = await import('./channelBootstrap');
  await runBootstrapDrainLoop();
} catch (e: any) {
  logError(`Bootstrap drain step failed: ${e.message}`, 'warn');
}
```

Dynamic `import` keeps startup fast and matches the spec's "isolated
try/catch" requirement.

**Dependencies:** C3 (worker/channelBootstrap.ts must exist).
**Parallel with:** nothing.

---

### Packet G — Integration walk-through

**Environment:** staging Heroku + disposable Slack channel + a real GHE
staging host (must be on VPN from the worker laptop).

**Steps (spec §9):**

1. `/pr-monitor add` in a disposable channel → verify:
   - Row appears in `monitored_channels`.
   - `SELECT COUNT(*) FROM channel_bootstrap_members WHERE channel_id='…' AND status='pending'` > 0.
   - Slack reply contains "Queued N member(s) for reviewer mapping."
2. `npx ts-node worker/channelBootstrap.ts` on the VPN laptop → verify:
   - Rows transition out of `pending` (into `resolved` or `unresolved`).
   - `user_mappings` gains rows with `discovered_via='bootstrap_search'`.
3. Invite a new human to the channel → verify `member_joined_channel`
   handler inserted exactly one `pending` row.
4. `npm run test-suggest-reviewers -- <pr-url>` against a PR whose
   author/file-touchers were just resolved → verify the Slack blocks
   use `<@U...>` mentions, not `` `ghe-login` `` fallbacks. **This is
   the acceptance check for the whole feature.**
5. **`aged_out` transition check.** Manually set one pending row's
   `attempts=2` via SQL (`UPDATE channel_bootstrap_members SET attempts=2
   WHERE id=...`), simulate a transient failure by revoking the GHE token
   for that host briefly (or pointing the hostname to an unroutable
   address), and run the drain loop once. Expect the row's `status` to
   transition to `aged_out` with `attempts=3`. Restore the token after.
6. **Event-delivery post-deploy check.** After the manifest update lands,
   confirm `member_joined_channel` is actually wired up:
   ```bash
   curl -s -X POST https://slack.com/api/apps.permissions.info \
     -H "Authorization: Bearer $SLACK_BOT_TOKEN" | jq '.info.scopes, .info.events'
   ```
   Expect `member_joined_channel` in the event list. If missing, the
   manifest update didn't take effect and step 3 will silently pass
   (because no event fires).

**Dependencies:** all previous packets merged.
**Parallel with:** nothing.

---

## 5. Review & rollout checklist

- [ ] Pre-flight items 0.1–0.4 resolved, results pasted into PR description.
- [ ] Slack manifest updated with `member_joined_channel` (0.3).
- [ ] `npm run compile` + `npm run migrate` clean on a dev DB.
- [ ] `scripts/testListConfiguredHosts.ts` prints expected hosts.
- [ ] `scripts/testChannelBootstrapEnqueue.ts` against a 5-person test channel inserts 5 pending rows (and dedupes on re-run).
- [ ] `worker/channelBootstrap.ts` run standalone on VPN resolves ≥1 row end-to-end, confirms rate-limit headers seen in 0.1.
- [ ] `/pr-monitor add` in a real channel surfaces the two-step reply within 1s + delayed count.
- [ ] `notifyError` fires with `'warn'` on a simulated worker-laptop-offline scenario (pull the network cable, run the worker tick).
- [ ] No regressions in existing reviewer-suggestion path (existing
      `npm run test-suggest-reviewers` still works against a non-bootstrap
      channel).

---

## 6. Rollback plan

This feature is additive. Rollback is per-concern:

- **Migration 021** is idempotent (`IF NOT EXISTS`). No down migration is
  needed — drop the table manually if we truly need to reset.
- **Worker drain** can be disabled by short-circuiting `runBootstrapDrainLoop`
  to return early (one-line commit, no data loss — queue fills but doesn't
  drain; reactive mapper still covers authors).
- **Slash-command two-step reply** degrades on throw to the fallback text —
  no Slack-side manual revert required. If the enqueue path causes unacceptable
  latency, gate it behind `process.env.ENABLE_CHANNEL_BOOTSTRAP`.
- **`member_joined_channel` handler** can be removed by deleting the handler
  and the manifest entry.

No `user_mappings` row written by this feature is distinguishable from
reactive-mapper rows except via `discovered_via='bootstrap_search'`, so
cleanup is scoped.

**Concrete cleanup query.** Capture `NOW()` at feature-enable time — e.g.
from the commit SHA deploy timestamp or the Heroku release timestamp — and
store it in the rollback runbook entry. Then:

```sql
-- Revoke only rows written by this feature after enable time.
-- Reactive mapper rows (discovered_via IN ('email_lookup','name_lookup',
-- 'ghe_profile','manual_config')) are untouched.
DELETE FROM user_mappings
 WHERE discovered_via = 'bootstrap_search'
   AND updated_at >= '<feature-enable-timestamp>';

-- Queue table is orphan-safe on rollback; leave in place or:
DROP TABLE IF EXISTS channel_bootstrap_members;
```

If timestamp capture is missed, the safer default is:
```sql
DELETE FROM user_mappings WHERE discovered_via = 'bootstrap_search';
```
— this removes any bootstrap row regardless of vintage. Reactive mapper
will re-seed on next PR observation.
