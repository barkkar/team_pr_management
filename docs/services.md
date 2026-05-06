# Services & Utils

Per-module reference for `src/services/` and `src/utils/`. Citations point into the source.

## `src/services/`

### `channelAccessControl.ts`

Module-load enforcement of the `ALLOWED_CHANNEL_IDS` env var. If it's unset or empty, enforcement is **disabled** — a warning is logged (`channelAccessControl.ts:31-36`) and `isChannelAllowed` always returns true. When the env var is a non-empty comma-separated list, `isChannelAllowed` checks membership against the parsed set. Every message handler and slash command calls `isChannelAllowed(channelId)` before doing anything.

- `isChannelAllowed(channelId): boolean` — short-circuits to `true` when enforcement is disabled (`channelAccessControl.ts:51`).
- `assertChannelAllowed(channelId, context)` — throws on denial; logs to console.error first.
- `getAllowedChannelIds(): string[]` — returns the allowlist as an array (empty when enforcement is disabled).

### `channelBootstrap.ts`

Proactive user-mapping bootstrap. When a channel is onboarded or a user joins, this module enqueues every real (non-bot, non-deleted, has-email) member into `channel_bootstrap_members` so the VPN worker can resolve their GHE logins ahead of their first PR. Callers: `/pr-monitor add` (via `setImmediate` in `src/app.ts:160-192`) and `member_joined_channel` (via `insertBootstrapMembers` directly in `src/app.ts:389`).

Implementation notes:
- Paginates `conversations.members` (1000/page) to get channel membership.
- Module-level 5-minute TTL cache on `users.list` with a single-flight mutex — concurrent callers share one fetch to keep Slack's Tier 2 rate limit happy (`channelBootstrap.ts:18-24`). Paginated at 200/page with a 200ms pause between pages.
- Filters out bots, deleted users, and members with no profile email before inserting.

Exports:
- `enqueueChannelBootstrap(channelId, slackClient): Promise<{ queued: number }>` — returns the count of freshly inserted rows (`insertBootstrapMembers` dedupes on `(channel_id, slack_user_id)`).

### `channelPoller.ts`

Heroku Scheduler's fallback path for PRs missed by Socket Mode. Pulls channels from `monitored_channels` + optional `POLL_CHANNEL_IDS` env var, dedupes, allowlist-filters, and walks `conversations.history` per channel using the `channel_poll_state` cursor. Skips bot-authored messages and messages with no text. Adds a `robot_face` reaction on newly-tracked messages; ignores `already_reacted`. 500ms delay between channels.

- `pollChannelsForPRs(client: WebClient): Promise<void>`

### `claudeClient.ts`

Routes every Claude chat and tool-use call. Two modes decided at import time by env vars:

1. **Bedrock proxy** (preferred): raw axios POST to `{BEDROCK_BASE_URL}/v1/messages` with `x-api-key: {AUTH_TOKEN}` + `anthropic-version: 2023-06-01`. The code strips a trailing `/bedrock` from the base URL (so `.../bedrock` and `.../bedrock/` both work). 120s timeout.
2. **Direct Anthropic API**: uses `@anthropic-ai/sdk`.

The code default model is `claude-3-5-sonnet-20241022` (`claudeClient.ts:20`); Heroku production overrides via `CLAUDE_MODEL` env var. `jsonMode` on `claudeChat` appends a hard instruction telling Claude to respond with valid JSON only, no code fences.

Exports:
- `claudeChat(systemPrompt?, userPrompt, { temperature?, maxTokens?, jsonMode? })` — single-turn chat.
- `claudeToolLoop(systemPrompt?, userPrompt, tools, options)` — multi-turn conversation with tool use. `tools` is a required `ClaudeTool[]`; `options` is a required `ToolLoopOptions` containing at least `onToolCall` plus optional `temperature`, `maxTokens`, `maxIterations` (default 6). The loop feeds tool results back to Claude until it returns `end_turn` / `stop_sequence` or hits `maxIterations`, then returns `{ finalText, iterations, toolCalls }`. Throws on unexpected `stop_reason` or iteration overrun.
- `extractJsonFromClaudeText<T>(text): T | null` — tolerant JSON parser for Claude final messages. Tries plain `JSON.parse`, then strips ` ```json ``` ` fences, then grabs the outermost `{...}` block. Used by the reviewer-suggestion workers because Claude Opus 4.x sometimes adds a preamble.
- `checkClaudeHealth()` — sends "Respond with exactly: ok" and verifies the reply contains "ok".
- `getClaudeModel(): string` — returns the model ID currently in effect.

Type exports: `ClaudeChatOptions`, `ClaudeTool`, `ClaudeToolCall`, `ClaudeToolResult`, `ToolLoopOptions`, `ToolLoopResult`.

Env vars read: `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`.


### `github.ts`

Per-hostname-cached Axios client for GitHub Enterprise. Base URL: `https://{hostname}/api/v3`. Token resolved via `gheTokenResolver`. 10s timeout.

- `class GitHubEnterpriseClient`
  - `getPRDetails(hostname, org, repo, prNumber)`
  - `getReviews(hostname, org, repo, prNumber)`
  - `hasReviews(...)` — excludes PENDING reviews *and* the PR author's own reviews.
  - `isPROpen(...)` — returns `state === 'open' && !merged`.


### `prTracker.ts`

Takes a Slack message body, extracts PR URLs via `parsePRsFromMessage`, and inserts each into `tracked_prs` with `eligible_reminder_at = getEligibleReminderTime(postedAt)`. Returns `{ tracked, skipped }` (skipped = already-tracked). The primary caller is the Socket Mode message handler; the poller also calls it.

- `trackPRsFromMessage(text, channelId, messageTs, postedAt): Promise<TrackingResult>`

### `reminder.ts`

Runs inside `scripts/checkReminders.ts`. Gated by `isWithinBusinessHours()`. For each pending reminder:

1. Requires worker-reported status fresh within **10 min** — else skip.
2. If PR is closed → `markPRClosed`, continue.
3. If reviewed → do nothing (skip; next check will see `has_reviews=TRUE`).
4. Otherwise, posts a reminder message to the original `channel_id` + `message_ts` (as a thread reply with PR link + `formatTimeAgo`), then `scheduleNextReminder(id, getNextReminderEligibleTime())`.

Rows with `reminders_cancelled = TRUE` are already excluded upstream by `getPendingReminders` (migration 022) — they never reach this loop. Cancellation is set via the `cancel_reminder` Slack message shortcut handled in `src/app.ts`; scope is `(channel_id, message_ts)`, so every PR link in a single Slack post is silenced together. Not reversible via the bot.

- `processPendingReminders(app: App): Promise<void>`


## `src/utils/`

### `errorNotifier.ts`

Slack error reporter. Gracefully no-ops if `SLACK_BOT_TOKEN` or `ERROR_SLACK_CHANNEL_ID` is missing. Key features:

- Throttle: 1 message per minute per `source::message` pair. The in-memory map is pruned when it exceeds 200 entries.
- Severity: `'warn' | 'error' | 'fatal'` — fatal uses a louder emoji.
- `details` are truncated to 2500 chars.
- Wrapped in try/catch; never rethrows.

- `notifyError(source, message, severity='error', details?)`

### `gheTokenResolver.ts`

Resolves a GHE token per hostname. `GHE_TOKENS` (JSON map `{host: token}`) takes priority; `GHE_TOKEN` is the fallback. Hostname lookup is case-insensitive. Token map is lazy-loaded and logged (just hostnames, not tokens).

- `getTokenForHost(hostname): string | null`
- `requireTokenForHost(hostname)` — throws if missing

### `prParser.ts`

Regex parser for PR URLs in Slack messages.

Regex (`prParser.ts:13`): `/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/g`.

- `parsePRsFromMessage(text): ParsedPR[]` — deduplicates URLs within the same message
- `containsPRLink(text): boolean`
- `interface ParsedPR { url, hostname, org, repo, prNumber }`

### `timezone.ts`

All business-hours math, built on Luxon.

- Timezone: `America/Los_Angeles`.
- Business hours: 9 AM – 5 PM, Mon–Fri.
- Reminder delay: 2 hours.

Functions:
- `getEligibleReminderTime(postedAt)` — if `postedAt ≥ 5 PM` or `postedAt + 2h ≥ 5 PM`, returns next 9 AM business day; weekends skipped.
- `isWithinBusinessHours()` — right-now gate for reminder posting.
- `getNextReminderEligibleTime()` — next 9 AM business day from now.
- `formatTimeAgo(date)` — `N days`, `N hours`, or `N minutes`.
