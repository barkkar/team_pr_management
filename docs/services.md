# Services & Utils

Per-module reference for `src/services/` and `src/utils/`. Citations point into the source.

## `src/services/`

### `channelAccessControl.ts`

Module-load enforcement of the `ALLOWED_CHANNEL_IDS` env var. If it's missing or empty the process exits — this is intentional, because `groups:history`/`channels:history` Slack scopes are broader than we want. Every message handler and slash command checks `isChannelAllowed(channelId)` before doing anything.

- `isChannelAllowed(channelId): boolean`
- `assertChannelAllowed(channelId, context)` — throws
- `getAllowedChannelIds(): string[]`

### `channelPoller.ts`

Heroku Scheduler's fallback path for PRs missed by Socket Mode. Pulls channels from `monitored_channels` + optional `POLL_CHANNEL_IDS` env var, dedupes, allowlist-filters, and walks `conversations.history` per channel using the `channel_poll_state` cursor. Skips bot-authored messages and messages with no text. Adds a `robot_face` reaction on newly-tracked messages; ignores `already_reacted`. 500ms delay between channels.

- `pollChannelsForPRs(client: WebClient): Promise<void>`

### `claudeClient.ts`

Routes every Claude chat call. Two modes decided at import time by env vars:

1. **Bedrock proxy** (preferred): raw axios POST to `{BEDROCK_BASE_URL}/v1/messages` with `x-api-key: {AUTH_TOKEN}` + `anthropic-version: 2023-06-01`. The code strips a trailing `/bedrock` from the base URL (so `.../bedrock` and `.../bedrock/` both work). 120s timeout.
2. **Direct Anthropic API**: uses `@anthropic-ai/sdk`.

The default model is `claude-3-5-sonnet-20241022` (`claudeClient.ts:21`). `jsonMode` appends a hard instruction telling Claude to respond with valid JSON only, no code fences.

- `claudeChat(systemPrompt | undefined, userPrompt, { temperature?=0.3, maxTokens?=4096, jsonMode?=false })`
- `checkClaudeHealth()` — sends "Respond with exactly: ok" and verifies the response contains "ok"
- `getClaudeModel(): string`
- `interface ClaudeChatOptions`

Env vars read: `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`.

### `codeContextProvider.ts`

Fetches domain-scoped code examples from `repo_knowledge` for the review pipeline. `worker/prAnalyzer.ts` calls it for all three passes (implementation, rules, tests) with pass-specific `element_types` filters. Given a set of `domainIds` + the changed files, it:

1. Queries `repo_knowledge` joined to `code_domains` with `domain_id = ANY($domainIds)`, filtering out rows whose `file_path` is in the PR diff.
2. Can filter by `element_types` (e.g., `['class', 'function']`) and scope by `org`/`repo`.
3. Fetches `3x limit`, then diversifies: max 1 example per file, skip a domain when its count exceeds 1.5× the average across domains.
4. `formatCodeExamplesForPrompt` renders each as a 500-char snippet with domain/file header.

- `fetchDomainScopedCodeExamples(options: CodeContextOptions): Promise<CodeExample[]>`
- `formatCodeExamplesForPrompt(examples): string`

### `embeddingService.ts`

Thin wrapper over the `ollama` client.

- `generateEmbedding(text): Promise<number[]>` — 768-dim via `OLLAMA_EMBED_MODEL` (default `nomic-embed-text`) against `OLLAMA_HOST` (default `http://localhost:11434`).
- `generateBatchEmbeddings(texts)` — batches of 10.
- `truncateForEmbedding(text, maxChars=30000)` — guards context windows.
- `formatReviewForEmbedding({...})` — formats a review as `Repo / File / State / Diff / Comment`.
- `checkOllamaHealth()`

### `github.ts`

Per-hostname-cached Axios client for GitHub Enterprise. Base URL: `https://{hostname}/api/v3`. Token resolved via `gheTokenResolver`. 10s timeout.

- `class GitHubEnterpriseClient`
  - `getPRDetails(hostname, org, repo, prNumber)`
  - `getReviews(hostname, org, repo, prNumber)`
  - `hasReviews(...)` — excludes PENDING reviews *and* the PR author's own reviews.
  - `isPROpen(...)` — returns `state === 'open' && !merged`.

### `ontologyEngine.ts`

The core of the deterministic rule system. See `docs/ontology.md` for the broader design. Exports:

- Resolution:
  - `resolveRulesForPR(changedFiles, diffText): Promise<ResolvedRule[]>` — combines file-path match + code-pattern match + annotation match.
  - `matchFilePathsToDomains`, `matchFilePathsToRules`, `matchCodePatterns` — building blocks.
  - `getRulesForDomains(domainIds)` — uses a recursive CTE to include ancestors of each domain in the lookup.
  - `getRulesByIds(ruleIds)`.
- CRUD for domains, rules, matchers, and file mappings: `createDomain`, `createRule`, `createRuleMatcher`, `createDomainFileMapping`, `updateRule`, `deleteRule`, `listRules`.
- Taxonomy: `getDomainTaxonomy()`, `getAllDomains()`.

Matchers:
- `file_path` via `minimatch(path, pattern, { dot: true, nocase: true })`.
- `code_pattern` — supports regex (`is_regex=true`) or case-insensitive substring.
- `annotation` — word-boundary regex.

`ResolvedRule` is sorted by severity critical → high → medium → low (no secondary sort).

### `prTracker.ts`

Takes a Slack message body, extracts PR URLs via `parsePRsFromMessage`, and inserts each into `tracked_prs` with `eligible_reminder_at = getEligibleReminderTime(postedAt)`. Returns `{ tracked, skipped }` (skipped = already-tracked). The primary caller is the Socket Mode message handler; the poller also calls it.

- `trackPRsFromMessage(text, channelId, messageTs, postedAt): Promise<TrackingResult>`

### `reminder.ts`

Runs inside `scripts/checkReminders.ts`. Gated by `isWithinBusinessHours()`. For each pending reminder:

1. Requires worker-reported status fresh within **10 min** — else skip.
2. If PR is closed → `markPRClosed`, continue.
3. If reviewed → do nothing (skip; next check will see `has_reviews=TRUE`).
4. Otherwise, posts a reminder message to the original `channel_id` + `message_ts` (as a thread reply with PR link + `formatTimeAgo`), then `scheduleNextReminder(id, getNextReminderEligibleTime())`.

- `processPendingReminders(app: App): Promise<void>`

### `reviewerSuggester.ts`

Legacy entry point that defers to `vectorSearch.findSuggestedReviewers` and resolves Slack IDs via `getUserMapping`. The live prAnalyzer flow uses `/api/suggested-reviewers` in `src/index.ts:749-843` instead, which composes file-based + code-touch + semantic signals directly. Keep both in sync if you change scoring.

- `getSuggestedReviewers(changedFiles, prAuthor?, topK=5)`
- `formatReviewerSuggestions(reviewers)`

### `reviewGenerator.ts`

Single-pass AI review generator. Superseded by the 3-pass flow in `worker/prAnalyzer.ts` for production, but still used as a building block (e.g., by `bootstrapLearner`). Calls `claudeChat` with `temperature=0.3, maxTokens=4096, jsonMode=true`. Prompts include up to 5 similar reviews (500-char snippets) + 3 similar code chunks (1000-char snippets) + PR diff truncated to 16K. Parses Claude's output with progressive fallbacks: direct JSON → strip markdown fences → brace-match the first `{...}` block. Validates shape and rejects invalid responses.

- `generateReview(prTitle, prDiff, changedFiles, similarReviews, similarCode): Promise<GeneratedReview>`
- `checkLLMHealth()`
- `interface ReviewComment`, `interface GeneratedReview`

### `ruleClassifier.ts`

The LLM fallback for `resolveRulesForPR`'s unmatched files. Sends a file path + truncated diff (4K chars) and the entire taxonomy; Claude returns an array of domain IDs (accepts `parsed[]`, `{domains:[...]}`, or `{domain_ids:[...]}`). IDs are validated against the loaded taxonomy; `getRulesForDomains` fetches rules. Called with `temperature=0.1, maxTokens=100, jsonMode=true`.

- `classifyDiffIntoDomains(filePath, diffSnippet, taxonomy?)`
- `classifyAndResolveRules(filePath, diffSnippet, taxonomy?)`
- `classifyUnmatchedFiles(unmatchedFiles): Promise<ResolvedRule[]>` — dedupes rules across files.

### `vectorSearch.ts`

Thin wrapper around the vector-search functions in `client.ts` plus the legacy three-signal reviewer scorer (past reviewers ×2 weight, code authors ×1, semantic similarity ×3; counts capped at 20; reason sentence is assembled from which signals fired).

- `findSimilarReviews(embedding, topK=10, minSimilarity=0.3)`
- `findSimilarCodeChunks(embedding, topK=10, minSimilarity=0.3)`
- `findSuggestedReviewers(filePaths, excludeAuthor?, topK=5, similarReviews?)`

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
