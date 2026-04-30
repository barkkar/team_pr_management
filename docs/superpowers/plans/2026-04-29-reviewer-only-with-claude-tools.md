# Reviewer-Only Mode with Claude Tool Use Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all AI code-review features and replace with a reviewer-suggestion flow where Claude fetches PR context via tool calls (worker executes the fetches against GHE/Postgres) and returns a ranked list of suggested reviewers. PR reminders stay intact.

**Architecture:** Worker fetches only the PR URL for a newly tracked PR, then invokes Claude with four tools — `fetch_pr_files`, `fetch_pr_diff`, `get_past_reviewers`, `get_past_authors`. A tool-loop helper in `src/services/claudeClient.ts` drives the round-trips: Claude decides what to fetch, worker executes, loop terminates when Claude returns an `end_turn` with the final JSON reviewer list. All review-generation code, ontology, learning, and Slack review UI are deleted. Slack posts a single concise thread reply naming the suggested reviewers.

**Base branch:** `feat/remove-ollama` (PR #1). This stacks on top so we can merge #1 first; if #1 is rebased into main before we start, this plan still applies — just rebase onto main.

**Tech stack:** TypeScript 5.7 strict CommonJS, Node 20, `@anthropic-ai/sdk` 0.80 (still installed), `axios`, `pg`, `@slack/bolt`, Heroku Postgres.

**Task ordering (hard):** Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8 → Task 9 → Task 10 → Task 11 → Task 12 → Task 13. Task 4 must precede Task 5 (import removals in Task 5 reference files deleted in Task 4). Task 2 must precede Task 3 (Task 3 imports `claudeToolLoop`). Task 7 migrations must ship with Heroku release — they are a data-destructive step.

**Hard constraints discovered in the code:**
- Anthropic Bedrock gateway lives at `ANTHROPIC_BEDROCK_BASE_URL/v1/messages` (`src/services/claudeClient.ts:80-82`). Both modes must support `tools` / `tool_use` content blocks. Gateway support must be confirmed in Task 1; if the gateway strips `tools`, we fall back to the direct Anthropic SDK and document that.
- GHE is VPN-only. Tool execution happens on the worker laptop; Claude never fetches URLs directly.
- Past-reviewer/author data is in Postgres (`pr_reviews`, `pr_files`), populated by `worker/prHarvester.ts`. Kept.
- `user_mappings` still needed for GHE→Slack ID resolution. `worker/userMapper.ts` kept.
- No test framework exists — verification is `tsc --noEmit` + targeted greps + a live dry-run with `npm run test-review -- <pr-url>`.

---

## File Structure

### Files to DELETE

| Path | Reason |
|---|---|
| `worker/bootstrapLearner.ts` | Lesson extraction gone |
| `worker/reviewLearner.ts` | Lesson extraction gone |
| `worker/repoHarvester.ts` | Code-chunk knowledge base no longer used |
| `worker/backfillDomainMetadata.ts` | Backfilled a column we're dropping |
| `worker/backfillDomainMetadataComplete.ts` | Same |
| `worker/backfillDomainMetadataWithLogging.ts` | Same |
| `src/services/ontologyEngine.ts` | Ontology review gone |
| `src/services/ruleClassifier.ts` | Claude-based classifier gone |
| `src/services/codeContextProvider.ts` | Only consumer is ontology review |

### Files to MODIFY

| Path | Change |
|---|---|
| `src/services/claudeClient.ts` | Add `claudeToolLoop(system, userPrompt, tools, onToolCall, options)` that wraps a tool-use conversation. Keep `claudeChat` unchanged for health check. |
| `worker/prAnalyzer.ts` | Replace the 3-pass review pipeline with a single `suggestReviewers(prUrl, channelId, messageTs)` that invokes `claudeToolLoop` with four tool handlers and reports final list. |
| `worker/localPRChecker.ts` | Remove lesson-extraction call; the per-PR analysis spawn still points at `prAnalyzer.js` (now reviewer-only). |
| `worker/testReview.ts` | Rename to `worker/testSuggestReviewers.ts` and rewrite to exercise the new pipeline (supports dry-run + `--post --channel=` and `--no-mention`). Add an npm script `test-suggest-reviewers`. |
| `src/index.ts` | Delete 13 endpoints (list below). Rename `formatSlackAnalysis` → `formatReviewerMessage` and slim it to only the reviewer block + no feedback buttons. Re-point `/api/pr-analysis` → new `/api/pr-reviewers` with different body shape. Remove imports for deleted DB helpers. Remove the startup log mention. |
| `src/app.ts` | Delete the `ai_review_helpful`, `ai_review_not_helpful`, `ai_review_feedback_modal`, `comment_helpful`, `comment_not_helpful` handlers. Remove `/pr-monitor harvest-status` subcommand and the `repo_knowledge` count line (still-needed columns removed by migration 019). Update `/pr-monitor help` text. |
| `src/db/client.ts` | Delete helpers for lessons, feedback, analysis-results, per-comment feedback, domain-scoped examples re-export. Keep `findReviewersByFiles`, `findCodeTouchersByFiles`, `getUserMapping`, `upsertUserMapping`, `getAllUserMappings`, tracked-PR and monitored-channel helpers, PR harvest upsert helpers, `upsertRepoKnowledge` (no — see below; since `repo_knowledge` is being dropped in the migration, the helper goes too). Update `RepoKnowledge`, `CodeExample` interfaces (CodeExample removed; RepoKnowledge removed). |
| `package.json` | Remove npm scripts: `harvest:repos`, `analyze-pr` renamed to `suggest-reviewers`, `test-review` → `test-suggest-reviewers`, `bootstrap-learn`, `review-learn`, `review-learn:watch`, `ingest-doc` (already gone). Keep `harvest`, `harvest:incremental`, `worker`, `worker:watch`, `map-users`. |
| `README.md`, `CLAUDE.md`, `docs/*.md` | Scrub all references to AI code review, ontology, lessons, feedback, `/api/ai-*`, `/api/ontology/*`, `pr_analysis_results`, `ai_review_*`, `ai_comment_feedback`, `repo_knowledge`, `team_documents`, `code_domains`, etc. Document the new tool-loop flow. |

### Files to CREATE

| Path | Purpose |
|---|---|
| `src/db/migrations/019_drop_review_artifacts.sql` | Drop `pr_analysis_results`, `ai_review_feedback`, `ai_review_lessons`, `ai_comment_feedback`, `code_domains`, `code_rules`, `rule_matchers`, `domain_file_mappings`, `rule_feedback`, `repo_knowledge`. Keep `pr_reviews`, `pr_files`, `harvest_state`, `user_mappings`, `tracked_prs`, `monitored_channels`, `channel_poll_state`. |
| `src/db/migrations/020_tracked_prs_suggestions_sent.sql` | Add `suggestions_sent BOOLEAN DEFAULT FALSE` column + `suggestions_sent_at TIMESTAMP` on `tracked_prs`, plus an index for the "needs suggestions" query. |

---

## Task 1: Confirm Bedrock gateway tool-use support

**Why:** Before we design around tool-use, we must verify the gateway actually proxies `tools` and returns `tool_use` content blocks. If not, we fall back to the direct Anthropic SDK and document that clearly.

**Files:** (none modified — diagnostic)

- [ ] **Step 1: Capture the current env values**

```bash
cd /Users/aarasakutti/Documents/GitHub/team_pr_management
grep -E 'ANTHROPIC_BEDROCK_BASE_URL|ANTHROPIC_AUTH_TOKEN|CLAUDE_MODEL|ANTHROPIC_API_KEY' .env | sed 's/=.*/=<redacted>/'
```
Expected: `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_MODEL` are set. `ANTHROPIC_API_KEY` may or may not be set.

- [ ] **Step 2: Send a tool-use test request to the gateway**

Use the exact pattern from `src/services/claudeClient.ts:80-92`. Save this as a one-off script at `/tmp/test_tools.ts`:

```ts
import 'dotenv/config';
import axios from 'axios';

async function main() {
  const baseUrl = process.env.ANTHROPIC_BEDROCK_BASE_URL!.replace(/\/bedrock\/?$/, '');
  const url = `${baseUrl}/v1/messages`;

  const body = {
    model: process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-20241022',
    max_tokens: 1024,
    messages: [
      { role: 'user', content: 'What is the weather in San Francisco? Use the get_weather tool.' },
    ],
    tools: [
      {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ],
  };

  const resp = await axios.post(url, body, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_AUTH_TOKEN!,
      'anthropic-version': '2023-06-01',
    },
    timeout: 30000,
  });

  console.log('stop_reason:', resp.data.stop_reason);
  console.log('content blocks:', JSON.stringify(resp.data.content, null, 2));
}
main().catch(e => { console.error(e.response?.data || e.message); process.exit(1); });
```

Run it:
```bash
npx ts-node /tmp/test_tools.ts
```

Expected:
- `stop_reason: "tool_use"`
- `content` is an array containing at least one block with `{ type: "tool_use", id: "...", name: "get_weather", input: {...} }`

If the gateway **strips** `tools` or refuses the request: proceed with **direct Anthropic SDK only** for this feature. Update Task 2 to route tool-use exclusively through the SDK path and log this decision prominently in `docs/services.md`.

- [ ] **Step 3: Record the outcome**

Write a one-paragraph note in the PR description (no file changes) stating either: (a) Bedrock gateway supports tool-use — verified commit SHA `TBD`, or (b) Bedrock gateway does not — falling back to direct SDK.

- [ ] **Step 4: Clean up the scratch script**

```bash
rm -f /tmp/test_tools.ts
```

- [ ] **Step 5: No commit — this is a diagnostic step.**

---

## Task 2: Add `claudeToolLoop` helper

**Files:**
- Modify: `src/services/claudeClient.ts`

- [ ] **Step 1: Add tool-use type exports + loop function at the end of `claudeClient.ts`**

After the existing `getClaudeModel()` function, append:

```ts
// ---------------------------------------------------------------------------
// Tool-use loop
// ---------------------------------------------------------------------------

export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ClaudeToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ClaudeToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ToolLoopOptions {
  temperature?: number;
  maxTokens?: number;
  maxIterations?: number; // hard cap on tool-use rounds (default 6)
  onToolCall: (call: ClaudeToolCall) => Promise<ClaudeToolResult>;
}

export interface ToolLoopResult {
  finalText: string;
  iterations: number;
  toolCalls: { name: string; input: any }[];
}

async function rawMessagesCall(body: any): Promise<any> {
  if (USE_BEDROCK) {
    const baseUrl = BEDROCK_BASE_URL!.replace(/\/bedrock\/?$/, '');
    const url = `${baseUrl}/v1/messages`;
    try {
      const response = await axios.post(url, body, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': AUTH_TOKEN!,
          'anthropic-version': '2023-06-01',
        },
        timeout: 120000,
      });
      return response.data;
    } catch (err: any) {
      const detail = err.response?.data
        ? JSON.stringify(err.response.data).substring(0, 500)
        : err.message;
      throw new Error(`Bedrock proxy failed (${err.response?.status || 'unknown'}): ${detail}`);
    }
  }
  if (ANTHROPIC_API_KEY) {
    // Direct SDK supports tools via messages.create
    const client = getDirectClient();
    const response = await client.messages.create(body);
    return response;
  }
  throw new Error(
    'Claude AI requires either ANTHROPIC_BEDROCK_BASE_URL + ANTHROPIC_AUTH_TOKEN (Bedrock proxy) '
    + 'or ANTHROPIC_API_KEY (direct API)',
  );
}

/**
 * Run a Claude conversation with tool use until the model returns end_turn or
 * we hit maxIterations. The caller provides tool definitions and an executor.
 *
 * Conversation shape:
 *   1. user: <userPrompt>
 *   2. assistant: [text] + [tool_use]  ← Claude decides to call a tool
 *   3. user: [tool_result]              ← we run the tool and send back the result
 *   4. repeat 2–3 until stop_reason === 'end_turn'
 */
export async function claudeToolLoop(
  systemPrompt: string | undefined,
  userPrompt: string,
  tools: ClaudeTool[],
  options: ToolLoopOptions,
): Promise<ToolLoopResult> {
  const {
    temperature = 0.2,
    maxTokens = 2048,
    maxIterations = 6,
    onToolCall,
  } = options;

  const messages: any[] = [{ role: 'user', content: userPrompt }];
  const toolCallLog: { name: string; input: any }[] = [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const body: any = {
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      temperature,
      messages,
      tools,
    };
    if (systemPrompt) body.system = systemPrompt;

    const response = await rawMessagesCall(body);

    const stopReason = response.stop_reason;
    const contentBlocks = Array.isArray(response.content) ? response.content : [];

    // Append assistant turn verbatim so Claude keeps context on subsequent calls
    messages.push({ role: 'assistant', content: contentBlocks });

    if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
      const finalText = contentBlocks
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('')
        .trim();
      return { finalText, iterations: iteration + 1, toolCalls: toolCallLog };
    }

    if (stopReason !== 'tool_use') {
      throw new Error(`Claude returned unexpected stop_reason=${stopReason}`);
    }

    // Find tool_use blocks and execute them
    const toolUseBlocks = contentBlocks.filter((b: any) => b.type === 'tool_use');
    if (toolUseBlocks.length === 0) {
      throw new Error('stop_reason=tool_use but no tool_use blocks present');
    }

    const toolResultBlocks: any[] = [];
    for (const block of toolUseBlocks) {
      const call: ClaudeToolCall = { id: block.id, name: block.name, input: block.input || {} };
      toolCallLog.push({ name: call.name, input: call.input });
      try {
        const result = await onToolCall(call);
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: result.tool_use_id,
          content: result.content,
          ...(result.is_error ? { is_error: true } : {}),
        });
      } catch (err: any) {
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: `Tool execution failed: ${err.message}`,
          is_error: true,
        });
      }
    }

    messages.push({ role: 'user', content: toolResultBlocks });
  }

  throw new Error(`claudeToolLoop exceeded maxIterations=${maxIterations}`);
}
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/aarasakutti/Documents/GitHub/team_pr_management
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/services/claudeClient.ts
git commit -m "feat(claudeClient): add claudeToolLoop helper for tool-use conversations"
```

---

## Task 3: Rewrite `worker/prAnalyzer.ts` as reviewer-only with tool loop

**Files:**
- Rewrite: `worker/prAnalyzer.ts`

- [ ] **Step 1: Replace the entire file contents**

Run: `Read worker/prAnalyzer.ts` first to confirm what's there, then replace with the following. Keep the shebang.

```ts
#!/usr/bin/env npx ts-node
/**
 * PR Analyzer — Reviewer Suggestions (tool-use)
 *
 * For a newly tracked PR this worker invokes Claude with four tools and lets
 * Claude decide what PR context to fetch. The worker executes the tools
 * against GHE and Postgres; Claude returns a ranked reviewer list as JSON.
 *
 * Tools:
 *   - fetch_pr_files(pr_url): returns list of changed file paths
 *   - fetch_pr_diff(pr_url, max_bytes?): returns unified diff text (truncated)
 *   - get_past_reviewers(file_paths): top-K GHE logins who reviewed similar files
 *   - get_past_authors(file_paths): top-K GHE logins who authored similar files
 *
 * Usage:
 *   npm run suggest-reviewers -- https://gitcore.soma.salesforce.com/org/repo/pull/42
 *   (or the polling loop picks PRs from /api/prs-needing-reviewer-suggestions)
 */

import 'dotenv/config';
import axios from 'axios';
import { notifyError } from '../src/utils/errorNotifier';
import { requireTokenForHost } from '../src/utils/gheTokenResolver';
import {
  claudeToolLoop,
  checkClaudeHealth,
  getClaudeModel,
  ClaudeTool,
  ClaudeToolCall,
  ClaudeToolResult,
} from '../src/services/claudeClient';

const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;

const DIFF_MAX_BYTES_DEFAULT = 60000;
const TOOL_CALL_CAP = 6;

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [PRAnalyzer] ${message}`);
}

function logError(message: string, severity: 'warn' | 'error' | 'fatal' = 'error'): void {
  console.error(`[${new Date().toISOString()}] [PRAnalyzer] ${message}`);
  notifyError('PRAnalyzer', message, severity);
}

function herokuHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Worker-API-Key': WORKER_API_KEY!,
  };
}

interface ParsedPrUrl {
  hostname: string;
  org: string;
  repo: string;
  prNumber: number;
}

function parsePrUrl(prUrl: string): ParsedPrUrl {
  const m = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Unrecognised PR URL: ${prUrl}`);
  return { hostname: m[1], org: m[2], repo: m[3], prNumber: parseInt(m[4], 10) };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolFetchPrFiles(prUrl: string): Promise<{ file_paths: string[]; pr_author: string }> {
  const { hostname, org, repo, prNumber } = parsePrUrl(prUrl);
  const token = requireTokenForHost(hostname);
  const headers = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };

  // Paginate to get every file. Safety cap at 10 pages (1000 files).
  const allFiles: string[] = [];
  for (let page = 1; page <= 10; page++) {
    const resp = await axios.get(
      `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      { headers, timeout: 15000 },
    );
    const batch: string[] = (resp.data || []).map((f: any) => f.filename).filter(Boolean);
    allFiles.push(...batch);
    if (batch.length < 100) break;
  }

  const prResp = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`,
    { headers, timeout: 15000 },
  );
  const prAuthor = prResp.data?.user?.login || '';

  return { file_paths: allFiles, pr_author: prAuthor };
}

async function toolFetchPrDiff(prUrl: string, maxBytes = DIFF_MAX_BYTES_DEFAULT): Promise<string> {
  const { hostname, org, repo, prNumber } = parsePrUrl(prUrl);
  const token = requireTokenForHost(hostname);
  const resp = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`,
    {
      headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3.diff' },
      timeout: 30000,
    },
  );
  const diff: string = resp.data || '';
  if (diff.length <= maxBytes) return diff;
  return diff.substring(0, maxBytes) + `\n...[truncated: ${diff.length - maxBytes} bytes omitted]`;
}

async function toolGetPastReviewers(filePaths: string[], prAuthor: string): Promise<any[]> {
  const resp = await axios.post(
    `${HEROKU_API_URL}/api/past-reviewers`,
    { file_paths: filePaths, pr_author: prAuthor, top_k: 10 },
    { headers: herokuHeaders(), timeout: 20000 },
  );
  return resp.data.reviewers || [];
}

async function toolGetPastAuthors(filePaths: string[], prAuthor: string): Promise<any[]> {
  const resp = await axios.post(
    `${HEROKU_API_URL}/api/past-authors`,
    { file_paths: filePaths, pr_author: prAuthor, top_k: 10 },
    { headers: herokuHeaders(), timeout: 20000 },
  );
  return resp.data.authors || [];
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

const TOOLS: ClaudeTool[] = [
  {
    name: 'fetch_pr_files',
    description: 'Fetch the list of files changed in the given PR and the PR author login. Call this first.',
    input_schema: {
      type: 'object',
      properties: { pr_url: { type: 'string' } },
      required: ['pr_url'],
    },
  },
  {
    name: 'fetch_pr_diff',
    description: 'Fetch the unified diff for the PR. Optional — call only if the file list is insufficient to judge reviewer fit.',
    input_schema: {
      type: 'object',
      properties: {
        pr_url: { type: 'string' },
        max_bytes: { type: 'number', description: 'Cap on diff size. Default 60000.' },
      },
      required: ['pr_url'],
    },
  },
  {
    name: 'get_past_reviewers',
    description: 'Return GHE logins who have previously reviewed the given files (exact path or same directory). Each entry: { ghe_login, review_count, files[] }.',
    input_schema: {
      type: 'object',
      properties: { file_paths: { type: 'array', items: { type: 'string' } } },
      required: ['file_paths'],
    },
  },
  {
    name: 'get_past_authors',
    description: 'Return GHE logins who have previously authored changes to the given files. Each entry: { ghe_login, change_count, files[] }.',
    input_schema: {
      type: 'object',
      properties: { file_paths: { type: 'array', items: { type: 'string' } } },
      required: ['file_paths'],
    },
  },
];

// ---------------------------------------------------------------------------
// Main: suggestReviewers
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a reviewer recommender for a software team. Given a pull request URL, you choose up to 5 suggested reviewers from the team's history.

Procedure:
1. Call fetch_pr_files to get the changed file list and PR author.
2. Call get_past_reviewers and get_past_authors with those file paths to build a candidate pool.
3. Optionally call fetch_pr_diff if the file names alone are insufficient to judge reviewer fit. Keep diff fetches minimal.
4. Exclude the PR author. Prefer candidates who both reviewed and authored related code.
5. Return up to 5 suggestions, ordered best-first, with a short human-readable reason per candidate.

Output format (final message — JSON only, no prose):
{
  "suggestions": [
    { "ghe_login": "...", "reason": "<one short sentence>" }
  ]
}`;

function buildUserPrompt(prUrl: string, channelId: string): string {
  return `PR URL: ${prUrl}\nSlack channel: ${channelId}\n\nSuggest up to 5 reviewers.`;
}

async function suggestReviewers(prUrl: string, channelId: string, messageTs: string): Promise<void> {
  log(`Processing ${prUrl}`);

  // Pre-parse to fail fast if URL is malformed
  parsePrUrl(prUrl);

  // Track cached author for the tool handlers (populated by fetch_pr_files)
  let cachedAuthor = '';

  const onToolCall = async (call: ClaudeToolCall): Promise<ClaudeToolResult> => {
    log(`  tool: ${call.name}`);
    try {
      if (call.name === 'fetch_pr_files') {
        const { pr_url } = call.input;
        const result = await toolFetchPrFiles(pr_url);
        cachedAuthor = result.pr_author;
        return { tool_use_id: call.id, content: JSON.stringify(result) };
      }
      if (call.name === 'fetch_pr_diff') {
        const { pr_url, max_bytes } = call.input;
        const diff = await toolFetchPrDiff(pr_url, max_bytes);
        return { tool_use_id: call.id, content: diff };
      }
      if (call.name === 'get_past_reviewers') {
        const { file_paths } = call.input;
        const rows = await toolGetPastReviewers(file_paths || [], cachedAuthor);
        return { tool_use_id: call.id, content: JSON.stringify(rows) };
      }
      if (call.name === 'get_past_authors') {
        const { file_paths } = call.input;
        const rows = await toolGetPastAuthors(file_paths || [], cachedAuthor);
        return { tool_use_id: call.id, content: JSON.stringify(rows) };
      }
      return { tool_use_id: call.id, content: `Unknown tool: ${call.name}`, is_error: true };
    } catch (err: any) {
      log(`  tool error (${call.name}): ${err.message}`);
      return { tool_use_id: call.id, content: `Error: ${err.message}`, is_error: true };
    }
  };

  const result = await claudeToolLoop(SYSTEM_PROMPT, buildUserPrompt(prUrl, channelId), TOOLS, {
    temperature: 0.2,
    maxTokens: 2048,
    maxIterations: TOOL_CALL_CAP,
    onToolCall,
  });

  log(`  Claude made ${result.toolCalls.length} tool call(s) over ${result.iterations} round(s)`);

  // Parse JSON — on failure, fall back to empty suggestions and still report.
  // This marks suggestions_sent=TRUE so we don't loop forever on a bad response.
  let suggestions: { ghe_login: string; reason: string }[] = [];
  try {
    const parsed = JSON.parse(result.finalText);
    suggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  } catch (e: any) {
    logError(`  Failed to parse Claude JSON output: ${e.message}. Raw: ${result.finalText.substring(0, 300)}`);
    // Fall through to POST with empty suggestions — keeps the PR from being retried forever.
  }

  suggestions = suggestions
    .filter(s => s && typeof s.ghe_login === 'string' && s.ghe_login.trim().length > 0)
    .slice(0, 5);

  log(`  Claude returned ${suggestions.length} suggestion(s)`);

  // Report to Heroku: stores the list and triggers Slack thread reply
  try {
    await axios.post(
      `${HEROKU_API_URL}/api/pr-reviewers`,
      {
        pr_url: prUrl,
        channel_id: channelId,
        message_ts: messageTs,
        suggestions,
      },
      { headers: herokuHeaders(), timeout: 30000 },
    );
    log('  ✅ Reviewer suggestions reported.');
  } catch (err: any) {
    logError(`  Failed to report results: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Polling mode
// ---------------------------------------------------------------------------

async function fetchPrsNeedingSuggestions(): Promise<any[]> {
  const resp = await axios.get(`${HEROKU_API_URL}/api/prs-needing-reviewer-suggestions`, {
    headers: herokuHeaders(),
    timeout: 30000,
  });
  return resp.data.prs || [];
}

async function runLoop(): Promise<void> {
  log('Checking for PRs needing reviewer suggestions...');
  const prs = await fetchPrsNeedingSuggestions();
  if (prs.length === 0) {
    log('None.');
    return;
  }
  log(`Found ${prs.length} PR(s) needing suggestions.`);
  for (const pr of prs) {
    try {
      await suggestReviewers(pr.pr_url, pr.channel_id, pr.message_ts);
    } catch (e: any) {
      logError(`Failed for ${pr.pr_url}: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  log('='.repeat(60));
  log('PR Analyzer (reviewer suggestions) starting...');
  log('='.repeat(60));

  if (!HEROKU_API_URL || !WORKER_API_KEY) {
    logError('HEROKU_API_URL and WORKER_API_KEY are required');
    process.exit(1);
  }
  if (!process.env.GHE_TOKEN && !process.env.GHE_TOKENS) {
    logError('GHE_TOKEN or GHE_TOKENS is required');
    process.exit(1);
  }

  const health = await checkClaudeHealth();
  if (!health.ok) {
    logError(`Claude not ready: ${health.error || 'unknown'}`);
    process.exit(1);
  }
  log(`Claude AI model ready: ${getClaudeModel()}`);

  const prUrlArg = process.argv.find(a => a.startsWith('https://'));
  if (prUrlArg) {
    await suggestReviewers(prUrlArg, 'manual', '0');
    return;
  }
  await runLoop();
}

run().then(() => process.exit(0)).catch((err: any) => {
  logError(`Fatal: ${err.message}`);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check**

```bash
cd /Users/aarasakutti/Documents/GitHub/team_pr_management
npx tsc --noEmit
```
Expected: Errors will mention missing endpoints `/api/past-reviewers`, `/api/past-authors`, `/api/prs-needing-reviewer-suggestions`, `/api/pr-reviewers`. That's acceptable at this step — **the TS type-check itself must still pass** (these are runtime strings, not types). If TypeScript errors show up, fix them here. Do not fix missing endpoints yet — that's Task 5.

- [ ] **Step 3: Commit**

```bash
git add worker/prAnalyzer.ts
git commit -m "refactor(prAnalyzer): rewrite as reviewer-suggestion tool-use worker"
```

---

## Task 4: Delete obsolete workers and services

**Files to delete:**
- `worker/bootstrapLearner.ts`
- `worker/reviewLearner.ts`
- `worker/repoHarvester.ts`
- `worker/backfillDomainMetadata.ts`
- `worker/backfillDomainMetadataComplete.ts`
- `worker/backfillDomainMetadataWithLogging.ts`
- `src/services/ontologyEngine.ts`
- `src/services/ruleClassifier.ts`
- `src/services/codeContextProvider.ts`

- [ ] **Step 1: Confirm no live importers remain**

```bash
cd /Users/aarasakutti/Documents/GitHub/team_pr_management
grep -rn --include='*.ts' -E "from ['\"](\.\.?/)*(services/)?(ontologyEngine|ruleClassifier|codeContextProvider)['\"]|from ['\"](\.\.?/)*worker/(bootstrapLearner|reviewLearner|repoHarvester|backfillDomainMetadata)" src/ worker/ scripts/
```
Expected: only hits inside the to-be-deleted files themselves. Any other hit → STOP and report BLOCKED.

- [ ] **Step 2: Delete the files**

```bash
rm \
  worker/bootstrapLearner.ts \
  worker/reviewLearner.ts \
  worker/repoHarvester.ts \
  worker/backfillDomainMetadata.ts \
  worker/backfillDomainMetadataComplete.ts \
  worker/backfillDomainMetadataWithLogging.ts \
  src/services/ontologyEngine.ts \
  src/services/ruleClassifier.ts \
  src/services/codeContextProvider.ts
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```
Expected: errors in `src/index.ts` from deleted ontology imports; fix those in Task 5. Errors in `src/db/client.ts` from the `codeContextProvider` re-export; fix those in Task 5.

If the only errors are of the form `Cannot find module '../services/(ontologyEngine|ruleClassifier|codeContextProvider)'` or `Cannot find module './(bootstrapLearner|…)'`, you may commit now and resolve in Task 5. Otherwise fix them here.

Actually — for safety, squash Task 4 and Task 5 into a single commit if anything else trips the compiler. Easier to keep them separate if the compiler agrees.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete ontology services and obsolete workers for reviewer-only mode"
```

---

## Task 5: Slim `src/index.ts` (remove review endpoints, add 3 new reviewer endpoints)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Identify the handler blocks to delete**

Eleven route groups to delete (use `grep -n "'/api/<name>'" src/index.ts` to locate the exact block, then delete the entire `if (url …) { … return; }`):

1. `'/api/domain-code-examples'` (~line 602)
2. `'/api/repo-knowledge'` (~line 546) — only writer was `repoHarvester` (deleted in Task 4)
3. `'/api/prs-needing-analysis'` (~line 705)
4. `'/api/pr-analysis'` (~line 728)
5. `'/api/repost-analysis'` (~line 770)
6. `'/api/ai-feedback'` (~line 832)
7. `'/api/prs-needing-lessons'` (~line 855)
8. `'/api/ai-lessons'` (~line 869)
9. `'/api/ai-learning-context'` (~line 891)
10. `'/api/closed-prs-without-lessons'` (~line 910)
11. `'/api/resolve-rules'` (~line 956)
12. All `/api/ontology/...` routes (8 occurrences — find with `grep -n "/api/ontology" src/index.ts` and delete each)

Plus:
- `'/api/domain-file-mappings'` (~line 492). This endpoint fed the now-deleted `repoHarvester` and reads a now-dropped table. Delete.

And the formatter helpers (replaced in Step 3):
- `formatSlackAnalysis` function + its `pushChunkedSections` helper + the `SLACK_SECTION_LIMIT` constant (~lines 55–286).

**Keep** (verified safe):
- `/api/harvest-data` — only writes to `pr_reviews` + `pr_files` + `harvest_state` (`src/index.ts:511-542`); no `repo_knowledge` writes. Still used by `prHarvester`.
- `/api/tracked-prs-for-harvest`, `/api/all-tracked-prs`, `/api/distinct-repos`, `/api/harvest-state`, `/api/user-mappings`, `/api/pending-prs`, `/api/pr-status`.

- [ ] **Step 2: Add three new endpoints**

Choose a location after the `GET /api/pending-prs` block (around line 417 pre-deletion; may shift after deletions). Add:

```ts
      // Reviewer discovery: past reviewers of the given files
      if (url === '/api/past-reviewers' && method === 'POST') {
        if (!validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const body = await parseJsonBody(req);
        const filePaths: string[] = body.file_paths || [];
        const prAuthor: string = body.pr_author || '';
        const topK = Math.min(parseInt(body.top_k ?? 10, 10) || 10, 20);

        const rows = await findReviewersByFiles(filePaths, topK);
        const reviewers = rows
          .filter(r => r.reviewer_login !== prAuthor)
          .map(r => ({ ghe_login: r.reviewer_login, review_count: r.review_count, files: r.files }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reviewers }));
        return;
      }

      // Reviewer discovery: past authors of the given files
      if (url === '/api/past-authors' && method === 'POST') {
        if (!validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const body = await parseJsonBody(req);
        const filePaths: string[] = body.file_paths || [];
        const prAuthor: string = body.pr_author || '';
        const topK = Math.min(parseInt(body.top_k ?? 10, 10) || 10, 20);

        const rows = await findCodeTouchersByFiles(filePaths, topK);
        const authors = rows
          .filter(r => r.author_login !== prAuthor)
          .map(r => ({ ghe_login: r.author_login, change_count: r.change_count, files: r.files }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ authors }));
        return;
      }

      // PRs needing reviewer suggestions: tracked in last 24h, not yet suggested
      if (url === '/api/prs-needing-reviewer-suggestions' && method === 'GET') {
        if (!validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const result = await pool.query(`
          SELECT pr_url, channel_id, message_ts, org, repo, pr_number
          FROM tracked_prs
          WHERE suggestions_sent = FALSE
            AND (is_open = TRUE OR is_open IS NULL)
            AND created_at > NOW() - INTERVAL '24 hours'
          ORDER BY created_at DESC
          LIMIT 10
        `);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prs: result.rows }));
        return;
      }
```

- [ ] **Step 3: Replace `formatSlackAnalysis` with `formatReviewerMessage`**

Delete the existing `formatSlackAnalysis`, `pushChunkedSections`, and `SLACK_SECTION_LIMIT` constant (lines ~54-286 before cleanup). Replace with:

```ts
const SLACK_SECTION_LIMIT = 2900;

function formatReviewerMessage(
  suggestions: { ghe_login: string; slack_user_id?: string | null; reason: string }[],
  prUrl: string,
): { text: string; blocks: any[] } {
  const blocks: any[] = [];

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: ':eyes: *Suggested reviewers for this PR*' },
  });

  if (!suggestions || suggestions.length === 0) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No reviewer suggestions available yet._' },
    });
    const text = ':eyes: Suggested reviewers — none available';
    return { text, blocks };
  }

  const mentionList = suggestions.map(s =>
    s.slack_user_id ? `<@${s.slack_user_id}>` : `\`${s.ghe_login}\``,
  );
  const mentionStr = mentionList.length === 1
    ? mentionList[0]
    : mentionList.slice(0, -1).join(', ') + ' and ' + mentionList[mentionList.length - 1];

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `Hey ${mentionStr}, could you take a look at <${prUrl}|this PR>?` },
  });

  const reasonLines = suggestions.map(s => {
    const mention = s.slack_user_id ? `<@${s.slack_user_id}>` : `\`${s.ghe_login}\``;
    return `• ${mention} — ${s.reason}`;
  }).join('\n');

  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: reasonLines.substring(0, SLACK_SECTION_LIMIT) }],
  });

  const text = `:eyes: Suggested reviewers — ${suggestions.length} suggestion(s)`;
  return { text, blocks };
}
```

- [ ] **Step 4: Add the new `/api/pr-reviewers` endpoint (replaces `/api/pr-analysis`)**

Place it near the other PR-lifecycle endpoints. This stores the suggestions, resolves Slack IDs via `user_mappings`, posts the thread reply, and marks `suggestions_sent=TRUE`:

```ts
      // Receive reviewer suggestions from worker and post to Slack
      if (url === '/api/pr-reviewers' && method === 'POST') {
        if (!validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const body = await parseJsonBody(req);
        const { pr_url, channel_id, message_ts, suggestions } = body;

        if (!pr_url || !Array.isArray(suggestions)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'pr_url and suggestions[] are required' }));
          return;
        }

        // Resolve Slack IDs and keep only users we can @-mention
        const resolved: { ghe_login: string; slack_user_id?: string | null; reason: string }[] = [];
        for (const s of suggestions as { ghe_login: string; reason: string }[]) {
          const mapping = await getUserMapping(s.ghe_login);
          if (!mapping?.slack_user_id) continue;
          resolved.push({
            ghe_login: s.ghe_login,
            slack_user_id: mapping.slack_user_id,
            reason: s.reason || 'familiar with this area of the codebase',
          });
        }

        // Mark the PR so we don't re-suggest
        await pool.query(
          'UPDATE tracked_prs SET suggestions_sent = TRUE WHERE pr_url = $1',
          [pr_url],
        );

        // Post Slack thread reply
        if (channel_id && channel_id !== 'manual' && message_ts && message_ts !== '0') {
          try {
            const slackMessage = formatReviewerMessage(resolved, pr_url);
            await app.client.chat.postMessage({
              channel: channel_id,
              thread_ts: message_ts,
              text: slackMessage.text,
              blocks: slackMessage.blocks,
              unfurl_links: false,
            });
            console.log(`[Worker API] Posted reviewer suggestions to ${channel_id}`);
          } catch (slackError: any) {
            console.error(`[Worker API] Failed Slack post: ${slackError.message}`);
            notifyError('WorkerAPI', `Failed to post reviewer suggestions: ${slackError.message}`);
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, resolved_count: resolved.length }));
        return;
      }
```

- [ ] **Step 5: Prune imports**

At the top of `src/index.ts` the current import from `./db/client` pulls a lot of names. Replace it with:

```ts
import {
  getPRsNeedingStatusCheck, updatePRStatus, PRStatusUpdate,
  getDistinctRepos, getHarvestState, upsertHarvestState,
  insertPRReview, insertPRFile, upsertUserMapping,
  findReviewersByFiles, findCodeTouchersByFiles,
  getUserMapping,
  pool,
} from './db/client';
```

Names removed: `upsertRepoKnowledge`, `upsertRepoHarvestState`, `fetchDomainScopedCodeExamples`, `insertReviewLessons`, `getRecentLessons`, `getPRsNeedingLessonExtraction`, `insertOrUpdateFeedback`, `getRecentFeedback`. Also delete the line `import { resolveRulesForPR, getDomainTaxonomy, ... } from './services/ontologyEngine';` entirely.

(Endpoint deletions already enumerated in Step 1; no additional endpoints to remove here.)

- [ ] **Step 6: Update the startup log line**

Find the existing line (~ `console.log('  - AI API: ...')`) and replace with:

```ts
    console.log(`  - Reviewer API: /api/pending-prs, /api/pr-status, /api/pr-reviewers, /api/past-reviewers, /api/past-authors, /api/prs-needing-reviewer-suggestions`);
```

- [ ] **Step 7: Type-check**

```bash
npx tsc --noEmit
```
Expected: clean. Fix anything left over.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts
git commit -m "refactor(api): remove review/ontology endpoints, add reviewer-suggestion endpoints"
```

---

## Task 6: Slim `src/app.ts` and `src/db/client.ts`

**Files:**
- Modify: `src/app.ts`
- Modify: `src/db/client.ts`

- [ ] **Step 1: Remove Slack review-feedback handlers from `src/app.ts`**

Delete the following handler registrations completely:
- `app.action('ai_review_helpful', …)`  (around line 379)
- `app.action('ai_review_not_helpful', …)` (around line 423)
- `app.view('ai_review_feedback_modal', …)` (around line 467)
- `app.action('comment_helpful', …)` (around line 489)
- `app.action('comment_not_helpful', …)` (around line 503)

Also remove the `insertOrUpdateFeedback` and `insertOrUpdateCommentFeedback` imports from the top of `src/app.ts`.

- [ ] **Step 2: Remove the `harvest-status` subcommand**

In the `/pr-monitor` switch (around line 271), delete the entire `case 'harvest-status':` block.

In the `help` response (around line 319), remove the line `• \`/pr-monitor harvest-status\` - Show AI knowledge base harvest status\n`.

- [ ] **Step 3: Type-check `src/app.ts`**

```bash
npx tsc --noEmit
```
Fix any import errors — in particular, you'll likely need to drop the unused `insertOrUpdateFeedback, insertOrUpdateCommentFeedback, pool` names from the `src/app.ts` imports.

- [ ] **Step 4: Trim `src/db/client.ts`**

Delete these exports (search by name):
- `insertOrUpdateFeedback`
- `getRecentFeedback`
- `insertOrUpdateCommentFeedback`
- `getCommentFeedbackStats`
- `insertReviewLessons`
- `getRecentLessons`
- `getPRsNeedingLessonExtraction`
- `upsertRepoKnowledge`
- `deleteRepoKnowledgeForFile`
- `upsertRepoHarvestState`
- The re-export line `export { fetchDomainScopedCodeExamples, formatCodeExamplesForPrompt } from '../services/codeContextProvider';`

Also delete the `RepoKnowledge` and `CodeExample` interfaces — neither is referenced after the above deletions.

- [ ] **Step 5: Add `suggestions_sent` to TrackedPR interface**

Find the `interface TrackedPR` definition and add at the end:

```ts
  suggestions_sent?: boolean;
```

- [ ] **Step 6: Type-check**

```bash
npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/app.ts src/db/client.ts
git commit -m "refactor(app, db): remove review feedback UI and dead DB helpers"
```

---

## Task 7: Schema migrations

**Files:**
- Create: `src/db/migrations/019_drop_review_artifacts.sql`
- Create: `src/db/migrations/020_tracked_prs_suggestions_sent.sql`

- [ ] **Step 1: Write migration 019**

Create `src/db/migrations/019_drop_review_artifacts.sql` with exactly:

```sql
-- Drop review-generation artifacts. Reviewer suggestions use tracked_prs +
-- pr_reviews + pr_files + user_mappings only.
--
-- FK ORDER (verified against migrations 015 + 017):
--   rule_matchers  → code_rules       (ON DELETE CASCADE)
--   rule_feedback  → code_rules       (no cascade)
--   code_rules     → code_domains
--   domain_file_mappings → code_domains (ON DELETE CASCADE)
--   repo_knowledge.domain_id → code_domains (no cascade — migration 017:6)
-- repo_knowledge must be dropped BEFORE code_domains.

DROP TABLE IF EXISTS ai_comment_feedback;
DROP TABLE IF EXISTS ai_review_feedback;
DROP TABLE IF EXISTS ai_review_lessons;
DROP TABLE IF EXISTS pr_analysis_results;

DROP TABLE IF EXISTS repo_knowledge;

DROP TABLE IF EXISTS rule_feedback;
DROP TABLE IF EXISTS rule_matchers;
DROP TABLE IF EXISTS code_rules;
DROP TABLE IF EXISTS domain_file_mappings;
DROP TABLE IF EXISTS code_domains;
```

- [ ] **Step 2: Write migration 020**

Create `src/db/migrations/020_tracked_prs_suggestions_sent.sql`:

```sql
-- Mark tracked PRs once the reviewer-suggestion worker has processed them.

ALTER TABLE tracked_prs
  ADD COLUMN IF NOT EXISTS suggestions_sent BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_tracked_prs_suggestions_pending
  ON tracked_prs (suggestions_sent, created_at)
  WHERE suggestions_sent = FALSE;
```

Note: not storing a timestamp. We don't re-suggest after an initial send, so the column would be unused.

- [ ] **Step 3: Optional local run**

If you have a local Postgres wired up:
```bash
npm run compile && npm run migrate
```
Expected: both migrations applied in order.

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/019_drop_review_artifacts.sql src/db/migrations/020_tracked_prs_suggestions_sent.sql
git commit -m "feat(db): migrations 019/020 — drop review artifacts, add suggestions_sent"
```

---

## Task 8: Remove lesson extraction from `worker/localPRChecker.ts`

**Files:**
- Modify: `worker/localPRChecker.ts`

- [ ] **Step 1: Delete the lesson-extraction call and the associated log line**

In `runWorker()` (around lines 441-446), delete the whole block including the log (no residual "triggering lesson extraction" log line should remain):

```ts
      // Trigger lesson extraction for newly closed PRs
      const closedPRs = results.filter(r => !r.error && !r.is_open);
      if (closedPRs.length > 0) {
        log(`\n${closedPRs.length} PR(s) detected as closed — triggering lesson extraction...`);
        await triggerLessonExtraction();
      }
```

- [ ] **Step 2: Delete the `triggerLessonExtraction`, `fetchPeerComments`, `generateLessons`, AND `triggerAnalysis` functions**

Current code spawns `prAnalyzer.js` as a child process via `triggerAnalysis()` (`worker/localPRChecker.ts:362-382`, called from line 453). The new `prAnalyzer.js` is itself a polling daemon (Task 3), so the spawn is redundant — `prAnalyzer.js` will poll `/api/prs-needing-reviewer-suggestions` on its own cadence. Delete the redundant spawn path:

1. Delete the `triggerAnalysis()` function definition (`worker/localPRChecker.ts:360-382`) including its comment block.
2. Delete the call `await triggerAnalysis();` on line 453 and the preceding log line `log('\nTriggering AI analysis for new PRs...');` on line 452.
3. Delete `fetchPeerComments`, `generateLessons`, `triggerLessonExtraction`.
4. Delete the `import { spawn } from 'child_process';` on line 22 if no remaining code uses it.
5. Delete `import path from 'path';` similarly if unused. Verify with: `grep -n "spawn\|path\." worker/localPRChecker.ts`.

After deletion, `runWorker()` should only do the PR-status check loop — no analysis spawning, no lesson extraction.

Conservative sweep: after these deletions, run `grep -n "^async function\|^function" worker/localPRChecker.ts` and confirm only `log`, `logError`, `herokuHeaders`, `extractHostname`, `fetchPendingPRs`, `checkPRStatus`, `reportStatus`, `runWorker` remain.

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```
Expected: clean. If the compiler flags unused imports at the top (e.g., `claudeChat`), remove them.

- [ ] **Step 4: Commit**

```bash
git add worker/localPRChecker.ts
git commit -m "refactor(localPRChecker): drop lesson extraction on PR close"
```

---

## Task 9: Rewrite `worker/testReview.ts` → `worker/testSuggestReviewers.ts`

**Files:**
- Rename + rewrite: `worker/testReview.ts` → `worker/testSuggestReviewers.ts`

- [ ] **Step 1: Rename the file**

```bash
git mv worker/testReview.ts worker/testSuggestReviewers.ts
```

- [ ] **Step 2: Replace the contents** (use `Read` first to confirm old contents, then `Write` the new file)

```ts
#!/usr/bin/env npx ts-node
/**
 * Test Suggest Reviewers
 *
 * Dry-run the tool-use reviewer-suggestion pipeline for a PR URL.
 *
 * Usage:
 *   npm run test-suggest-reviewers -- <pr-url>
 *   npm run test-suggest-reviewers -- <pr-url> --post --channel=C123
 */

import 'dotenv/config';
import axios from 'axios';
import { requireTokenForHost } from '../src/utils/gheTokenResolver';
import {
  claudeToolLoop,
  checkClaudeHealth,
  getClaudeModel,
  ClaudeTool,
  ClaudeToolCall,
  ClaudeToolResult,
} from '../src/services/claudeClient';

const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

function log(msg: string): void { console.log(`[${new Date().toISOString()}] ${msg}`); }
function parseUrl(prUrl: string) {
  const m = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Unrecognised PR URL: ${prUrl}`);
  return { hostname: m[1], org: m[2], repo: m[3], prNumber: parseInt(m[4], 10) };
}

const TOOLS: ClaudeTool[] = [
  { name: 'fetch_pr_files', description: 'Fetch changed files + PR author', input_schema: { type: 'object', properties: { pr_url: { type: 'string' } }, required: ['pr_url'] } },
  { name: 'fetch_pr_diff', description: 'Fetch unified diff', input_schema: { type: 'object', properties: { pr_url: { type: 'string' }, max_bytes: { type: 'number' } }, required: ['pr_url'] } },
  { name: 'get_past_reviewers', description: 'Past reviewers of these files', input_schema: { type: 'object', properties: { file_paths: { type: 'array', items: { type: 'string' } } }, required: ['file_paths'] } },
  { name: 'get_past_authors', description: 'Past authors of these files', input_schema: { type: 'object', properties: { file_paths: { type: 'array', items: { type: 'string' } } }, required: ['file_paths'] } },
];

const SYSTEM_PROMPT = `You are a reviewer recommender. Call fetch_pr_files first, then get_past_reviewers and get_past_authors on those files. Optionally call fetch_pr_diff. Return up to 5 suggestions as JSON: {"suggestions":[{"ghe_login":"...","reason":"..."}]}. Exclude the PR author.`;

async function main() {
  const prUrl = process.argv.find(a => a.startsWith('https://'));
  if (!prUrl) { console.error('Usage: npm run test-suggest-reviewers -- <pr-url> [--post --channel=C123]'); process.exit(1); }
  const shouldPost = process.argv.includes('--post');
  const channelArg = process.argv.find(a => a.startsWith('--channel='));
  const channelId = channelArg ? channelArg.split('=')[1] : '';

  if (!HEROKU_API_URL || !WORKER_API_KEY) { console.error('HEROKU_API_URL + WORKER_API_KEY required'); process.exit(1); }

  const health = await checkClaudeHealth();
  if (!health.ok) { console.error(`Claude not ready: ${health.error}`); process.exit(1); }
  log(`Claude model: ${getClaudeModel()}`);

  let cachedAuthor = '';

  const onToolCall = async (call: ClaudeToolCall): Promise<ClaudeToolResult> => {
    log(`tool: ${call.name} input=${JSON.stringify(call.input).substring(0, 200)}`);
    try {
      if (call.name === 'fetch_pr_files') {
        const { hostname, org, repo, prNumber } = parseUrl(call.input.pr_url);
        const token = requireTokenForHost(hostname);
        const filesResp = await axios.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/files?per_page=100`, { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }, timeout: 15000 });
        const prResp = await axios.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`, { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' }, timeout: 15000 });
        cachedAuthor = prResp.data?.user?.login || '';
        const result = { file_paths: (filesResp.data || []).map((f: any) => f.filename), pr_author: cachedAuthor };
        log(`  -> ${result.file_paths.length} files, author=${cachedAuthor}`);
        return { tool_use_id: call.id, content: JSON.stringify(result) };
      }
      if (call.name === 'fetch_pr_diff') {
        const { hostname, org, repo, prNumber } = parseUrl(call.input.pr_url);
        const token = requireTokenForHost(hostname);
        const maxBytes = call.input.max_bytes || 60000;
        const resp = await axios.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`, { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3.diff' }, timeout: 30000 });
        const diff: string = resp.data || '';
        const truncated = diff.length <= maxBytes ? diff : diff.substring(0, maxBytes) + `\n...[truncated ${diff.length - maxBytes} bytes]`;
        log(`  -> diff ${truncated.length} bytes`);
        return { tool_use_id: call.id, content: truncated };
      }
      if (call.name === 'get_past_reviewers') {
        const resp = await axios.post(`${HEROKU_API_URL}/api/past-reviewers`, { file_paths: call.input.file_paths || [], pr_author: cachedAuthor, top_k: 10 }, { headers: { 'X-Worker-API-Key': WORKER_API_KEY!, 'Content-Type': 'application/json' }, timeout: 20000 });
        log(`  -> ${(resp.data.reviewers || []).length} reviewers`);
        return { tool_use_id: call.id, content: JSON.stringify(resp.data.reviewers || []) };
      }
      if (call.name === 'get_past_authors') {
        const resp = await axios.post(`${HEROKU_API_URL}/api/past-authors`, { file_paths: call.input.file_paths || [], pr_author: cachedAuthor, top_k: 10 }, { headers: { 'X-Worker-API-Key': WORKER_API_KEY!, 'Content-Type': 'application/json' }, timeout: 20000 });
        log(`  -> ${(resp.data.authors || []).length} authors`);
        return { tool_use_id: call.id, content: JSON.stringify(resp.data.authors || []) };
      }
      return { tool_use_id: call.id, content: `Unknown tool: ${call.name}`, is_error: true };
    } catch (err: any) {
      log(`  !! tool error: ${err.message}`);
      return { tool_use_id: call.id, content: `Error: ${err.message}`, is_error: true };
    }
  };

  const result = await claudeToolLoop(SYSTEM_PROMPT, `PR URL: ${prUrl}\nSuggest up to 5 reviewers.`, TOOLS, {
    temperature: 0.2, maxTokens: 2048, maxIterations: 6, onToolCall,
  });

  log(`Claude made ${result.toolCalls.length} tool call(s), ${result.iterations} rounds`);
  log(`Final text:\n${result.finalText}`);

  if (shouldPost && channelId) {
    if (!SLACK_BOT_TOKEN) { console.error('SLACK_BOT_TOKEN needed for --post'); return; }
    const parsed = JSON.parse(result.finalText);
    await axios.post(`${HEROKU_API_URL}/api/pr-reviewers`, { pr_url: prUrl, channel_id: channelId, message_ts: '0', suggestions: parsed.suggestions || [] }, { headers: { 'X-Worker-API-Key': WORKER_API_KEY!, 'Content-Type': 'application/json' } });
    log('Posted to Slack via /api/pr-reviewers.');
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(testReview): rename + rewrite as testSuggestReviewers with tool-use"
```

---

## Task 10: Update `package.json` scripts and dist cleanup

**Files:**
- Modify: `package.json`
- Delete: stale compiled files under `dist/`

- [ ] **Step 1: Update scripts**

Replace the `scripts` block to reflect the new/removed workers. Final state:

```json
  "scripts": {
    "compile": "./node_modules/.bin/tsc && cp -r src/db/migrations dist/src/db/",
    "start": "node dist/src/index.js",
    "dev": "npx ts-node src/index.ts",
    "check-reminders": "node dist/scripts/checkReminders.js",
    "migrate": "node dist/src/db/migrate.js",
    "heroku-postbuild": "echo 'Build skipped - using pre-compiled dist'",
    "worker": "node dist/worker/localPRChecker.js",
    "worker:watch": "node dist/worker/localPRChecker.js --watch",
    "delete-bot-messages": "npx ts-node scripts/deleteBotMessages.ts",
    "test-ghe": "node dist/scripts/testGheConnectivity.js",
    "harvest": "node dist/worker/prHarvester.js",
    "harvest:incremental": "node dist/worker/prHarvester.js --incremental",
    "map-users": "node dist/worker/userMapper.js",
    "suggest-reviewers": "node dist/worker/prAnalyzer.js",
    "test-suggest-reviewers": "npx ts-node worker/testSuggestReviewers.ts"
  },
```

Removed scripts: `harvest:repos`, `analyze-pr`, `test-review`, `bootstrap-learn`, `review-learn`, `review-learn:watch`.

- [ ] **Step 2: Run `npm install` to refresh the lockfile if needed**

```bash
npm install
```
Expected: no changes since dependencies are unchanged; if there is a change it's to `package-lock.json` metadata only.

- [ ] **Step 3: Clean stale compiled artifacts**

```bash
rm -f \
  dist/worker/bootstrapLearner.* \
  dist/worker/reviewLearner.* \
  dist/worker/repoHarvester.* \
  dist/worker/backfillDomainMetadata*.* \
  dist/worker/testReview.* \
  dist/src/services/ontologyEngine.* \
  dist/src/services/ruleClassifier.* \
  dist/src/services/codeContextProvider.*
```

- [ ] **Step 4: Full compile**

```bash
npm run compile
```
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: update npm scripts for reviewer-only mode"
```

---

## Task 11: Update README, CLAUDE.md, and docs/

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/architecture.md`
- Modify: `docs/database.md`
- Modify: `docs/services.md`
- Modify: `docs/api-endpoints.md`
- Modify: `docs/workers.md`
- Modify: `docs/environment.md`

- [ ] **Step 1: Strategy**

For each doc: remove references to "AI code review", "3-pass review", "ontology", "lessons", "feedback buttons", `pr_analysis_results`, `ai_review_lessons`, `ai_review_feedback`, `ai_comment_feedback`, `repo_knowledge`, `code_domains`, `code_rules`, `domain_file_mappings`, `rule_matchers`, `rule_feedback`. Replace the "3-pass Claude review" narrative with:

> The worker invokes Claude with four tools (`fetch_pr_files`, `fetch_pr_diff`, `get_past_reviewers`, `get_past_authors`). Claude decides what to fetch; the worker executes each tool call against GHE + Postgres and returns results. After up to 6 rounds, Claude returns a JSON list of up to 5 suggested reviewers with reasons. The Heroku app resolves Slack IDs and posts a threaded reply.

- [ ] **Step 2: Do the edits**

For each file above, make targeted edits. Use `Read` then `Edit`. Don't rewrite unrelated sections.

Key updates:
- `README.md`: update Features list (drop "AI review generation", keep "suggest reviewers"), remove `/api/*` tables for deleted endpoints, update Project Structure (delete files gone, add `testSuggestReviewers.ts`), update Scripts table, drop `bootstrap-learn` etc.
- `CLAUDE.md`: rule change — "Reviewer suggestions use Claude tool-use; Claude does not do code review." Drop pitfalls about `reviewLearner.ts` and `localPRChecker.ts` sharing lesson extraction.
- `docs/architecture.md`: rewrite §4 (3-pass pipeline) as the tool-loop; remove §6 learning loop; update the topology diagram to drop the ontology mention.
- `docs/database.md`: mark 6 tables as "Removed in migration 019"; drop the related `client.ts` helper entries. Note new `tracked_prs.suggestions_sent` column.
- `docs/services.md`: delete sections for `ontologyEngine.ts`, `ruleClassifier.ts`, `codeContextProvider.ts`. Update `claudeClient.ts` to document `claudeToolLoop` + tool interfaces.
- `docs/api-endpoints.md`: delete Vector/Review/Ontology/Team-documents sections. Add this new table:

  ```markdown
  ## Reviewer Suggestions

  | Method | Path | Body / Query | Purpose |
  |---|---|---|---|
  | POST | `/api/past-reviewers` | `{file_paths[], pr_author?, top_k?}` (default 10, max 20) | Returns `{reviewers: [{ghe_login, review_count, files[]}]}` — past reviewers of the given files (exact path or same directory). Excludes `pr_author`. |
  | POST | `/api/past-authors` | `{file_paths[], pr_author?, top_k?}` (default 10, max 20) | Returns `{authors: [{ghe_login, change_count, files[]}]}`. Excludes `pr_author`. |
  | GET | `/api/prs-needing-reviewer-suggestions` | — | Tracked PRs from last 24h with `suggestions_sent=FALSE`. LIMIT 10. |
  | POST | `/api/pr-reviewers` | `{pr_url, channel_id, message_ts, suggestions: [{ghe_login, reason}]}` | Worker submits final reviewer list. Server resolves Slack IDs via `user_mappings`, posts threaded reply, sets `tracked_prs.suggestions_sent=TRUE`. |
  ```
- `docs/workers.md`: delete entries for the 6 deleted worker files; rewrite `prAnalyzer.ts` and `testSuggestReviewers.ts` entries; drop lesson-extraction mention from `localPRChecker.ts`.
- `docs/environment.md`: nothing changes (no new env vars).

- [ ] **Step 3: Final sweep**

```bash
grep -rn -i 'ontology\|ai_review\|ai_comment_feedback\|pr_analysis_results\|bootstrapLearner\|reviewLearner\|repoHarvester\|repo_knowledge\|code_domains\|code_rules\|rule_matchers\|domain_file_mappings\|rule_feedback\|lesson' CLAUDE.md README.md docs/ 2>&1 | grep -v 'docs/superpowers/plans/'
```
Expected: hits only in explicit "removed" / "no longer used" phrasing. Anything that reads like a live claim → fix.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md docs/
git commit -m "docs: scrub review/ontology content, document reviewer-suggestion tool-use flow"
```

---

## Task 12: End-to-end smoke verification

**Files:** (none modified)

- [ ] **Step 1: Full compile**

```bash
npm run compile
```
Expected: succeeds.

- [ ] **Step 2: Local DB migration (if available)**

```bash
npm run migrate
```
Expected: migrations 019 and 020 applied. If no local DB, skip.

- [ ] **Step 3: Startup smoke**

```bash
npm run dev
```
Expected: Slack Socket Mode connects, HTTP server listens on 3000, no import errors. Ctrl-C after 10s.

- [ ] **Step 4: Worker startup smoke**

```bash
npm run worker
```
Expected: completes one iteration. If it errors, capture the error.

- [ ] **Step 5: Dry-run the new pipeline against a real PR**

Pick a PR URL that exists in your GHE. Run:

```bash
npm run test-suggest-reviewers -- <pr-url>
```

Expected output should include:
- `Claude model: <model-id>`
- Multiple `tool:` log lines (at least `fetch_pr_files`, then `get_past_reviewers` and `get_past_authors`)
- Final text as JSON with `suggestions: [...]`
- `Claude made N tool call(s), M rounds`

If Claude times out or the Bedrock gateway returned an error about `tools`, refer to Task 1 — fall back to direct SDK.

- [ ] **Step 6: Final grep sweep**

```bash
grep -rn -i --include='*.ts' --include='*.json' --include='*.example' --include='*.sql' \
  'ontologyEngine\|ruleClassifier\|codeContextProvider\|bootstrapLearner\|reviewLearner\|repoHarvester\|ai_review_lessons\|pr_analysis_results\|ai_comment_feedback\|ai_review_feedback\|rule_matchers\|code_domains' . 2>/dev/null \
  | grep -v node_modules | grep -v dist/ | grep -v 'docs/superpowers/plans/'
```
Expected: only hits are inside `src/db/migrations/019_*` (intentional).

- [ ] **Step 7: No commit — verification only.**

---

## Task 13: Deploy playbook (documentation only)

**Files:** (none modified)

- [ ] **Step 1: Pre-deploy data sanity + size audit**

```bash
heroku pg:psql -a <app> <<'EOF'
SELECT 'pr_analysis_results' AS tbl, COUNT(*) FROM pr_analysis_results
UNION ALL SELECT 'ai_review_lessons', COUNT(*) FROM ai_review_lessons
UNION ALL SELECT 'ai_review_feedback', COUNT(*) FROM ai_review_feedback
UNION ALL SELECT 'ai_comment_feedback', COUNT(*) FROM ai_comment_feedback
UNION ALL SELECT 'repo_knowledge', COUNT(*) FROM repo_knowledge
UNION ALL SELECT 'code_rules', COUNT(*) FROM code_rules
UNION ALL SELECT 'code_domains', COUNT(*) FROM code_domains
UNION ALL SELECT 'rule_matchers', COUNT(*) FROM rule_matchers
UNION ALL SELECT 'rule_feedback', COUNT(*) FROM rule_feedback
UNION ALL SELECT 'domain_file_mappings', COUNT(*) FROM domain_file_mappings;
EOF
```

If any row has data you want to preserve, STOP and export before deploy. If any table has > 1M rows, `DROP TABLE` may exceed the Heroku release-phase timeout; in that case, run the drops manually during a maintenance window via `heroku pg:psql` before pushing the release.

- [ ] **Step 2: Deploy**

```bash
git push heroku feat/reviewer-only:main
```
Heroku release phase runs `npm run migrate` → applies 019 and 020.

- [ ] **Step 3: Health check**

```bash
curl -s https://<app>.herokuapp.com/health
curl -s -o /dev/null -w '%{http_code}\n' -H "X-Worker-API-Key: $(heroku config:get WORKER_API_KEY -a <app>)" -X POST https://<app>.herokuapp.com/api/pr-analysis -H 'Content-Type: application/json' -d '{}'
```
Expected: `/health` returns OK; `/api/pr-analysis` returns `404`.

- [ ] **Step 4: Worker laptop refresh**

On the VPN laptop, after Heroku health is green. **Critical**: a stale `dist/worker/prAnalyzer.js` will 404 against the removed `/api/prs-needing-analysis`. Clean before rebuild.

```bash
git pull
npm install
rm -rf dist/
npm run compile
npm run worker:watch
```
Expected: worker polls and reports status without Ollama or ontology log lines. Any 404 for `/api/prs-needing-*` means an old compiled file survived — re-check the `rm -rf dist/` step.

- [ ] **Step 5: Manual dry-run post**

Pick a quiet channel you're allowed to post in. Find a real tracked PR that still has `suggestions_sent=FALSE`:

```bash
heroku pg:psql -a <app> -c "SELECT pr_url, channel_id, message_ts FROM tracked_prs WHERE suggestions_sent = FALSE ORDER BY created_at DESC LIMIT 5"
```

Then from the laptop:
```bash
npm run test-suggest-reviewers -- <pr-url> --post --channel=<CXXX>
```

Expected: a threaded reviewer-suggestion message in that Slack thread.

- [ ] **Step 6: Rollback caveat**

Migration 019 is destructive and forward-only. If a rollback is required, restore the dropped tables' schemas manually (the prior migration SQL is the authoritative source — re-run migrations 008–017) before `heroku rollback`.

---

## Self-Review

**Spec coverage**:
- ✅ Reviews + feedback UI + lessons removed (Tasks 4, 6, 7, 8)
- ✅ Ontology + code-knowledge RAG removed (Tasks 4, 7)
- ✅ Reviewer suggestions stay and are enhanced with Claude tool-use (Tasks 2, 3, 5)
- ✅ Reminders untouched (`src/services/reminder.ts`, `src/utils/timezone.ts`, `scripts/checkReminders.ts` not modified by this plan)
- ✅ Harvester (`prHarvester` + `userMapper`) kept (populates `pr_reviews` + `pr_files` for the scorer)
- ✅ `suggestions_sent` marker added to avoid double-sending (Task 7)
- ✅ Migration 019 drops 10 review tables; migration 020 adds the marker column (Task 7)
- ✅ Slack thread reply simplified to reviewers-only (Task 5 `formatReviewerMessage`)
- ✅ Task 1 hedges the Bedrock tool-use unknown before we build on it

**Placeholder scan**: none. Every step names exact files and quotes exact old/new content.

**Type consistency**:
- `claudeToolLoop` signature is single point of truth (Task 2); `prAnalyzer` and `testSuggestReviewers` both consume the same `ClaudeTool`/`ClaudeToolCall`/`ClaudeToolResult` types.
- `/api/pr-reviewers` body `{pr_url, channel_id, message_ts, suggestions: [{ghe_login, reason}]}` — matches worker POST in Task 3 and endpoint reader in Task 5.
- `/api/past-reviewers` returns `{reviewers: [{ghe_login, review_count, files[]}]}`, `/api/past-authors` returns `{authors: [{ghe_login, change_count, files[]}]}` — matches Task 3 tool handlers.

**Known caveats**:
- Task 1 is a live-test diagnostic. If the Bedrock gateway doesn't support `tools`, the entire architecture still works — it just flows through `claudeToolLoop`'s direct-SDK branch (already implemented in Task 2).
- Task 4 may need to be squashed with Task 5 if the compiler trips too hard on dangling imports. Decision deferred to the implementer.
- Task 11 docs surgery is text-heavy. Use `Edit` with precise old/new strings, not `Write`.
- No automated tests exist. Smoke verification in Task 12 Step 5 is the only end-to-end signal — always run it before merging.
