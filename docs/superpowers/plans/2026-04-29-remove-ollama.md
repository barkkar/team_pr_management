# Remove Ollama Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every Ollama integration from the codebase, with the accompanying endpoints, schema columns, env vars, worker, and docs, so the repo no longer depends on a local embedding server.

**Architecture:** Strip Ollama-backed embedding generation from the three review workers (`prAnalyzer`, `testReview`, `bootstrapLearner`), delete the standalone `embeddingPipeline` + `docIngester` workers, remove the RAG endpoints that exist only to consume those embeddings, drop the vector columns + `pr_embeddings` / `team_documents` tables, and update docs. Retrieval degrades gracefully: reviewer suggestions lose the semantic-similarity signal but keep file-path/author signals; `ai_review_lessons` retrieval falls back to recency (already implemented — `src/index.ts:1053`); code examples still flow through the deterministic `fetchDomainScopedCodeExamples` keyword path.

**Tech Stack:** TypeScript 5.7 (CommonJS, strict mode), Node 20, `pg` 8.18 + pgvector extension (retained but unused), `@slack/bolt` 4.6, `axios` 1.13, Heroku Postgres.

**Plan assumptions (confirmed by user):**
- No replacement embedding provider. Accept degraded Pass-1 RAG.
- Drop `pr_embeddings` table, `team_documents` table, and the `embedding` column from `repo_knowledge` + `ai_review_lessons`. Keep the `vector` extension enabled.
- Remove `worker/docIngester.ts` and all team-document endpoints/DB helpers.
- No unit-test framework exists in the repo — verification is `tsc --noEmit`, targeted greps, and a smoke test of `npm run test-review -- <pr-url>` against a known PR.

---

## File Structure

### Files to DELETE

| Path | Why |
|---|---|
| `src/services/embeddingService.ts` | Dead code (no importers, confirmed via grep) + pulls `ollama` |
| `worker/embeddingPipeline.ts` | Entire purpose is Ollama → `/api/embeddings` |
| `worker/docIngester.ts` | Entire purpose is embedding team documents |

### Files to MODIFY

| Path | Purpose of change |
|---|---|
| `worker/prAnalyzer.ts` | Remove `ollama` import + `generateEmbedding`; drop `fetchSimilarReviews` / `fetchSimilarCode` / `fetchSimilarDocs` / `fetchDocsByTitlePattern`; call `fetchLearningContext()` with no args; simplify `fetchSuggestedReviewers` call; remove health check |
| `worker/testReview.ts` | Same as prAnalyzer; also drop the `similarCode` printout/logging |
| `worker/bootstrapLearner.ts` | Same as prAnalyzer; `reportLessons` sends no embedding; `buildUserPrompt` signature simplified |
| `src/index.ts` | Delete 8 endpoints (see Task 4); remove dead imports; update startup log |
| `src/db/client.ts` | Delete `insertEmbedding`, `updateRepoKnowledgeEmbedding`, `getUnembeddedPRReviews`, `getUnembeddedRepoKnowledge`, `searchSimilarReviews`, `searchSimilarCode`, `searchSimilarDocs`, `searchDocsByTitlePattern`, `upsertDocumentChunks`, `listDocuments`, `deleteDocument`, **`getSimilarLessons`**; drop the `embedding` write branch in `insertReviewLessons` |
| `src/services/codeContextProvider.ts` | Remove the `AND rk.embedding IS NOT NULL` filter on the `repo_knowledge` query (column will be dropped by migration 018) |
| `src/app.ts` | Remove the `pr_embeddings` count query from `/pr-monitor harvest-status` (table dropped) |
| `src/services/vectorSearch.ts` | Delete entirely (no importer once we remove `reviewerSuggester`/dead wrappers), OR — minimal option — remove only `findSimilarReviews`/`findSimilarCodeChunks` (still imported nowhere). **Take delete path.** |
| `src/services/reviewerSuggester.ts` | Imports `vectorSearch`. Not imported anywhere (grep confirms). **Delete.** |
| `src/services/reviewGenerator.ts` | Only caller was `reviewerSuggester` ecosystem? Confirm: grep shows no importer. **Delete.** (single-pass legacy) |
| `package.json` | Remove `ollama` dep; remove `npm run embed` and `npm run ingest-doc` scripts |
| `.env.example` | Remove `OLLAMA_HOST`, `OLLAMA_EMBED_MODEL`, the "Ollama Configuration" comment block |
| `README.md` | Remove Ollama from architecture diagram, prerequisites, `.env` tables, project-structure table; drop `test-review` env-var Ollama lines |
| `CLAUDE.md` | Remove the "Ollama stays local" rule; update VPN worker bullet to drop Ollama from the list |
| `docs/architecture.md` | Remove Ollama from topology diagram; remove §3 Ollama-embed steps; remove "Don't use Ollama for chat" line (no longer relevant); update §4 to note embedding steps are gone |
| `docs/database.md` | Update vector-columns preamble; mark `pr_embeddings`, `team_documents`, vector columns as removed; delete the pgvector-patterns section |
| `docs/services.md` | Delete the `embeddingService.ts`, `reviewGenerator.ts`, `reviewerSuggester.ts`, `vectorSearch.ts` sections |
| `docs/api-endpoints.md` | Delete the Vector-search, Embeddings, and Team-documents sections (one-shot) |
| `docs/workers.md` | Delete the `embeddingPipeline.ts` + `docIngester.ts` entries; remove Ollama mentions from prAnalyzer/testReview/bootstrapLearner |
| `docs/environment.md` | Remove `OLLAMA_HOST`, `OLLAMA_EMBED_MODEL`; remove `ollama` package row |

### Files to CREATE

| Path | Purpose |
|---|---|
| `src/db/migrations/018_drop_embedding_artifacts.sql` | Drops `pr_embeddings`, `team_documents`, `repo_knowledge.embedding`, `ai_review_lessons.embedding` + their IVFFlat indexes |

---

## Task 1: Strip Ollama + RAG embeddings from `worker/prAnalyzer.ts`

**Files:**
- Modify: `worker/prAnalyzer.ts`

- [ ] **Step 1: Remove the `ollama` import and host constants**

Open `worker/prAnalyzer.ts`. Delete these lines exactly:

- Line 22: `import { Ollama } from 'ollama';`
- Lines 29–30:
  ```ts
  const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
  ```

- [ ] **Step 2: Remove the `getOllama` helper + local `generateEmbedding`**

Delete lines 54–73 (the entire `// Ollama helpers` block from the `// ---` comment to the closing `}` of `generateEmbedding`):

```ts
// ---------------------------------------------------------------------------
// Ollama helpers
// ---------------------------------------------------------------------------

let ollama: Ollama | null = null;
function getOllama(): Ollama {
  if (!ollama) {
    ollama = new Ollama({ host: OLLAMA_HOST });
  }
  return ollama;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const client = getOllama();
  const response = await client.embed({
    model: OLLAMA_EMBED_MODEL,
    input: text.substring(0, 2000),
  });
  return response.embeddings[0];
}
```

- [ ] **Step 3: Remove the four vector-fetch functions**

Delete `fetchSimilarReviews` (lines 224–231), `fetchSimilarCode` (233–240), `fetchSimilarDocs` (242–253), `fetchDocsByTitlePattern` (255–269). Leave `fetchOntologyRules` and below.

- [ ] **Step 4: Simplify `fetchLearningContext` to recency-only**

Replace the whole `fetchLearningContext` function (lines 368–388 range — find by name) with:

```ts
async function fetchLearningContext(): Promise<{ lessons: any[]; feedback: any[] }> {
  try {
    const response = await axios.get(
      `${HEROKU_API_URL}/api/ai-learning-context?limit=5`,
      { headers: herokuHeaders(), timeout: 15000 },
    );
    return { lessons: response.data.lessons || [], feedback: response.data.feedback || [] };
  } catch {
    return { lessons: [], feedback: [] };
  }
}
```

- [ ] **Step 5: Remove the embedding + similar-reviews step from `analyzePR`**

In `analyzePR` (`worker/prAnalyzer.ts:~750+`), replace the block around lines 810–824:

Before:
```ts
  log('  Generating diff embedding...');
  const diffEmbedding = await generateEmbedding(diffSummary);

  // 2. Vector search for similar context
  log('  Searching for similar past reviews...');
  let similarReviews: any[] = [];
  try {
    similarReviews = await fetchSimilarReviews(diffEmbedding, 10);
    log(`  Found ${similarReviews.length} similar past reviews`);
  } catch (error: any) {
    log(`  No similar reviews found: ${error.message}`);
  }

  // Vector search removed - replaced by domain-scoped code examples below
```

After:
```ts
  // Semantic vector search removed — domain-scoped code examples
  // (via fetchDomainScopedCodeExamples below) replace this path.
  const similarReviews: any[] = [];
```

- [ ] **Step 6: Remove the file-context embedding block**

In `analyzePR`, delete the block around lines 845–852:

```ts
  // 3c. Build file-context summary and generate embedding
  let fileContextEmbedding = diffEmbedding; // fallback
  let fileContextSummary = '';
  if (fileContents.length > 0) {
    fileContextSummary = buildFileContextSummary(fileContents);
    log('  Generating file-context embedding...');
    fileContextEmbedding = await generateEmbedding(fileContextSummary);
  }
```

If `fileContextSummary` / `fileContextEmbedding` / `buildFileContextSummary` are used anywhere else below in `analyzePR`, delete those uses too. Grep in-file: `grep -n 'fileContextEmbedding\|fileContextSummary\|buildFileContextSummary' worker/prAnalyzer.ts`.

- [ ] **Step 7: Update `fetchLearningContext` call site**

Around line 918:

Before:
```ts
  const learningContext = await fetchLearningContext(diffEmbedding);
```

After:
```ts
  const learningContext = await fetchLearningContext();
```

Also remove the reference to `diffEmbedding` earlier if nothing else uses it — grep confirms in-file.

- [ ] **Step 8: Update `fetchSuggestedReviewers` call**

Around line 984, the call passes `similarReviews` (now always empty array) which is the semantic signal. Leave as-is (it's a no-op semantic signal now, and the endpoint tolerates an empty array — `src/index.ts:797`). No code change this step.

- [ ] **Step 9: Remove the Ollama health check from the preflight**

Lines 1057–1065 — delete the whole Ollama verification block (from the `// Verify Ollama (embeddings only)` comment through its `catch` close). Leave the Claude preflight above it intact.

- [ ] **Step 10: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. If there are unused-variable errors for `diffEmbedding` / `fileContext*` / `buildFileContextSummary`, delete those declarations too.

- [ ] **Step 11: Commit**

```bash
git add worker/prAnalyzer.ts
git commit -m "refactor(prAnalyzer): drop Ollama embeddings and semantic search"
```

---

## Task 2: Strip Ollama + RAG embeddings from `worker/testReview.ts`

**Files:**
- Modify: `worker/testReview.ts`

- [ ] **Step 1: Remove Ollama import + host constants**

Delete:
- Line 17: `import { Ollama } from 'ollama';`
- Lines 23–24: the two `OLLAMA_*` constants.

- [ ] **Step 2: Remove the `getOllama` helper + local `generateEmbedding`**

Delete lines 53–73 (the `// Ollama` comment block and the `generateEmbedding` function).

- [ ] **Step 3: Remove the four vector-fetch functions**

Delete `fetchSimilarReviews` (~line 223), `fetchSimilarCode` (~232), `fetchSimilarDocs` (~241), `fetchDocsByTitlePattern` (~254).

- [ ] **Step 4: Simplify `fetchLearningContext`**

Replace with:

```ts
async function fetchLearningContext(): Promise<{ lessons: any[]; feedback: any[] }> {
  try {
    const response = await axios.get(
      `${HEROKU_API_URL}/api/ai-learning-context?limit=5`,
      { headers: herokuHeaders(), timeout: 15000 },
    );
    return { lessons: response.data.lessons || [], feedback: response.data.feedback || [] };
  } catch {
    return { lessons: [], feedback: [] };
  }
}
```

- [ ] **Step 5: Delete the "dry-run" embedding printouts**

In the body of the dry-run runner (around lines 1027–1070):

Before (representative):
```ts
  const diffEmbedding = await generateEmbedding(diffSummary);
  console.log(`  Embedding dimensions: ${diffEmbedding.length}`);

  // 2. Vector search
  let similarReviews: any[] = [];
  try {
    similarReviews = await fetchSimilarReviews(diffEmbedding, 10);
    console.log(`  Found ${similarReviews.length} similar past reviews:\n`);
    for (let i = 0; i < similarReviews.length; i++) { ... }
  } catch (e) { ... }

  let similarCode: any[] = [];
  try {
    similarCode = await fetchSimilarCode(diffEmbedding, 5);
    console.log(`  Found ${similarCode.length} related code chunks:\n`);
    for (let i = 0; i < similarCode.length; i++) { ... }
  } catch (e) { ... }

  try {
    learningContext = await fetchLearningContext(diffEmbedding);
  } catch (e) { ... }
```

After:
```ts
  // Semantic vector search removed — retrieval now uses ontology/keyword only.
  const similarReviews: any[] = [];
  const similarCode: any[] = [];
  const learningContext = await fetchLearningContext();
```

Also remove the file-context-embedding block (around lines 1107–1119) — same pattern as Task 1 Step 6.

- [ ] **Step 6: Remove the Ollama health check at ~line 971**

Delete lines 971–980 (the `// Verify Ollama (embeddings only)` block).

- [ ] **Step 7: Fix Pass 1 prompt call if it referenced `similarCode`**

At ~line 1163: `pass1_userPrompt(prTitle, implDiff, implFiles, similarReviews, learningContext)` — already does not take `similarCode`. Leave untouched.

Verify `similarCode` is not referenced elsewhere: `grep -n similarCode worker/testReview.ts` → should only show the `const similarCode: any[] = [];` you wrote. If it's never read, delete the declaration.

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add worker/testReview.ts
git commit -m "refactor(testReview): drop Ollama embeddings and semantic search"
```

---

## Task 3: Strip Ollama + RAG embeddings from `worker/bootstrapLearner.ts`

**Files:**
- Modify: `worker/bootstrapLearner.ts`

- [ ] **Step 1: Remove Ollama import + host constants**

Delete:
- Line 24: `import { Ollama } from 'ollama';`
- Lines 30–31: the two `OLLAMA_*` constants.

- [ ] **Step 2: Remove the `getOllama` helper + local `generateEmbedding`**

Delete lines 52–65 (the `// Ollama helpers` block and `generateEmbedding`).

- [ ] **Step 3: Remove the four vector-fetch functions**

Delete `fetchSimilarReviews` (~line 236), `fetchSimilarCode` (~245), `fetchSimilarDocs` (~254), `fetchDocsByTitlePattern` (~267).

- [ ] **Step 4: Simplify `fetchLearningContext`**

Replace the function body with:

```ts
async function fetchLearningContext(): Promise<{ lessons: any[]; feedback: any[] }> {
  try {
    const response = await axios.get(
      `${HEROKU_API_URL}/api/ai-learning-context?limit=5`,
      { headers: herokuHeaders(), timeout: 15000 },
    );
    return { lessons: response.data.lessons || [], feedback: response.data.feedback || [] };
  } catch {
    return { lessons: [], feedback: [] };
  }
}
```

- [ ] **Step 5: Drop embedding from `reportLessons`**

At line 331–335, change:

Before:
```ts
async function reportLessons(prUrl: string, aiReview: any, peerComments: any[], lessons: any, embedding?: number[]): Promise<void> {
  await axios.post(`${HEROKU_API_URL}/api/ai-lessons`, {
    pr_url: prUrl, ai_review: aiReview, peer_comments: peerComments, lessons, embedding,
  }, { headers: herokuHeaders(), timeout: 30000 });
}
```

After:
```ts
async function reportLessons(prUrl: string, aiReview: any, peerComments: any[], lessons: any): Promise<void> {
  await axios.post(`${HEROKU_API_URL}/api/ai-lessons`, {
    pr_url: prUrl, ai_review: aiReview, peer_comments: peerComments, lessons,
  }, { headers: herokuHeaders(), timeout: 30000 });
}
```

- [ ] **Step 6: Simplify `buildUserPrompt` signature**

Find the `buildUserPrompt` declaration (~line 380). Its signature is:

```ts
function buildUserPrompt(
  prTitle: string, prDiff: string, changedFiles: string[],
  similarReviews: any[], similarCode: any[],
  learningContext?: { lessons: any[]; feedback: any[] },
  similarDocs?: any[],
): string
```

Change to:

```ts
function buildUserPrompt(
  prTitle: string, prDiff: string, changedFiles: string[],
  learningContext?: { lessons: any[]; feedback: any[] },
): string
```

In the body, delete the `similarReviews` (`if (similarReviews.length > 0)`) block, the `similarCode` section, and the `relevantRules = (similarDocs || [])` block. Keep the `learningContext` logic.

- [ ] **Step 7: Delete embedding generation inside `processPR`**

Around lines 630–680 (`processPR`), collapse to:

Before (representative):
```ts
    const diffEmbedding = await generateEmbedding(diffSummary);

    let similarReviews: any[] = [];
    try { similarReviews = await fetchSimilarReviews(diffEmbedding, 10); } catch (e) { ... }

    let similarCode: any[] = [];
    try { similarCode = await fetchSimilarCode(diffEmbedding, 5); } catch (e) { ... }
    log(`         ${similarReviews.length} similar reviews, ${similarCode.length} code chunks`);
    ...
    let fileContextEmbedding = diffEmbedding;
    ...
    fileContextEmbedding = await generateEmbedding(fileContextSummary);
    ...
    const learningContext = await fetchLearningContext(diffEmbedding);
    ...
    const userPrompt = buildUserPrompt(prTitle, prDiff, changedFiles, similarReviews, similarCode, learningContext, cappedDocs);
```

After:
```ts
    // Semantic retrieval removed; ontology + recency-based lessons only.
    const learningContext = await fetchLearningContext();
    ...
    const userPrompt = buildUserPrompt(prTitle, prDiff, changedFiles, learningContext);
```

Also update the `reportLessons(...)` call at line 722 to pass only four arguments (drop `diffEmbedding`).

- [ ] **Step 8: Delete Ollama health check in preflight**

Lines 771–780 — delete the whole `// Verify Ollama (embeddings only)` block (from the comment through the `catch`).

- [ ] **Step 9: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. Delete any other dead references to `cappedDocs`, `similarDocs`, `fileContextSummary` the compiler flags.

- [ ] **Step 10: Commit**

```bash
git add worker/bootstrapLearner.ts
git commit -m "refactor(bootstrapLearner): drop Ollama embeddings and semantic search"
```

---

## Task 4: Delete the standalone embedding workers

**Files:**
- Delete: `worker/embeddingPipeline.ts`
- Delete: `worker/docIngester.ts`
- Delete: `src/services/embeddingService.ts`

- [ ] **Step 1: Verify no imports**

Run these greps — all should return zero results (ignore the files themselves):

```bash
grep -rn --include='*.ts' "from.*'./embeddingPipeline'\|from.*'./docIngester'\|from.*'./embeddingService'\|from.*'../services/embeddingService'" src/ worker/ scripts/
```

Expected: no output.

- [ ] **Step 2: Delete the three files**

```bash
rm worker/embeddingPipeline.ts worker/docIngester.ts src/services/embeddingService.ts
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add -A src/services/embeddingService.ts worker/embeddingPipeline.ts worker/docIngester.ts
git commit -m "chore: delete Ollama-only workers (embeddingPipeline, docIngester, embeddingService)"
```

---

## Task 5: Delete the legacy non-Ollama dead code (`vectorSearch`, `reviewerSuggester`, `reviewGenerator`)

**Why:** These are only importable from each other and from the dead `embeddingService` we just removed. Grep confirms no production importer.

**Files:**
- Delete: `src/services/vectorSearch.ts`
- Delete: `src/services/reviewerSuggester.ts`
- Delete: `src/services/reviewGenerator.ts`

- [ ] **Step 1: Verify no importers**

```bash
grep -rn --include='*.ts' "from.*'./vectorSearch'\|from.*'./reviewerSuggester'\|from.*'./reviewGenerator'\|from.*'../services/vectorSearch'\|from.*'../services/reviewerSuggester'\|from.*'../services/reviewGenerator'" src/ worker/ scripts/
```

Expected: only self-references inside the three files themselves. If anything else appears, STOP and re-plan.

- [ ] **Step 2: Delete the three files**

```bash
rm src/services/vectorSearch.ts src/services/reviewerSuggester.ts src/services/reviewGenerator.ts
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add -A src/services/vectorSearch.ts src/services/reviewerSuggester.ts src/services/reviewGenerator.ts
git commit -m "chore: delete legacy dead services (vectorSearch, reviewerSuggester, reviewGenerator)"
```

---

## Task 6: Remove Ollama-only endpoints and DB helpers from Heroku app

**Files:**
- Modify: `src/index.ts`
- Modify: `src/db/client.ts`

- [ ] **Step 1: Remove vector-search endpoints from `src/index.ts`**

Delete these route handler blocks (search by the route string, delete the full `if` block including the trailing `return;`):

- `/api/embeddings` POST (line ~601)
- `/api/repo-knowledge-embeddings` POST (~631)
- `/api/unembedded-reviews` GET (~659)
- `/api/unembedded-repo-knowledge` GET (~676)
- `/api/search-similar-reviews` POST (~717)
- `/api/search-similar-code` POST (~733)
- `/api/search-similar-docs` POST (~1105)
- `/api/search-docs-by-title` POST (~1121)
- `/api/team-documents` (entire `if (url.startsWith('/api/team-documents'))` block, ~1143)

- [ ] **Step 2: Patch the `/api/ai-lessons` handler**

Around `src/index.ts:1010` — the body accepts `embedding` but never uses it meaningfully after this change. Update:

Before:
```ts
        const body = await parseJsonBody(req);
        const { pr_url, ai_review, peer_comments, lessons, embedding } = body;
        ...
        await insertReviewLessons(pr_url, ai_review || {}, peer_comments || [], lessons || {}, embedding);
        console.log(`[Worker API] Stored lessons for ${pr_url} (embedding: ${embedding ? 'yes' : 'no'})`);
```

After:
```ts
        const body = await parseJsonBody(req);
        const { pr_url, ai_review, peer_comments, lessons } = body;
        ...
        await insertReviewLessons(pr_url, ai_review || {}, peer_comments || [], lessons || {});
        console.log(`[Worker API] Stored lessons for ${pr_url}`);
```

- [ ] **Step 3: Patch the `/api/ai-learning-context` handler**

Around `src/index.ts:1034-1061` — **replace the entire handler block**, removing the POST-with-embedding branch, the `getSimilarLessons` call, and the `parseJsonBody` read. Old callers that still send a JSON body are tolerated — the body is ignored. New block, verbatim:

```ts
      if (url.startsWith('/api/ai-learning-context') && (method === 'POST' || method === 'GET')) {
        if (!validateApiKey(req)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const params = new URL(url, `http://${req.headers.host}`).searchParams;
        const limit = parseInt(params.get('limit') || '5', 10);

        const lessons = await getRecentLessons(Math.min(limit, 5));
        const feedback = await getRecentFeedback(Math.min(limit, 3));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lessons, feedback }));
        return;
      }
```

Important: this is a full replacement of lines 1034–1061 (inclusive). `getSimilarLessons` must no longer be referenced anywhere in `src/index.ts` after this step — that's why it's also listed in Step 4 (import removal) and Step 6 (function deletion).

- [ ] **Step 4: Prune top-of-file imports in `src/index.ts`**

Replace the three-line import block at `src/index.ts:6-19` so it only imports what's still referenced:

Before (approx lines 5–19):
```ts
import {
  getPRsNeedingStatusCheck, updatePRStatus, PRStatusUpdate,
  getDistinctRepos, getHarvestState, upsertHarvestState, upsertRepoHarvestState,
  insertPRReview, insertPRFile, upsertUserMapping,
  upsertRepoKnowledge, insertEmbedding, updateRepoKnowledgeEmbedding,
  getUnembeddedPRReviews, getUnembeddedRepoKnowledge,
  searchSimilarReviews, searchSimilarCode,
  findReviewersByFiles, findCodeTouchersByFiles,
  getUserMapping,
  insertOrUpdateFeedback, getRecentFeedback,
  insertReviewLessons, getRecentLessons, getSimilarLessons, getPRsNeedingLessonExtraction,
  searchSimilarDocs, searchDocsByTitlePattern, upsertDocumentChunks, listDocuments, deleteDocument,
  fetchDomainScopedCodeExamples,
  pool,
} from './db/client';
```

After:
```ts
import {
  getPRsNeedingStatusCheck, updatePRStatus, PRStatusUpdate,
  getDistinctRepos, getHarvestState, upsertHarvestState, upsertRepoHarvestState,
  insertPRReview, insertPRFile, upsertUserMapping,
  upsertRepoKnowledge,
  findReviewersByFiles, findCodeTouchersByFiles,
  getUserMapping,
  insertOrUpdateFeedback, getRecentFeedback,
  insertReviewLessons, getRecentLessons, getPRsNeedingLessonExtraction,
  fetchDomainScopedCodeExamples,
  pool,
} from './db/client';
```

Note: the removed names include `insertEmbedding`, `updateRepoKnowledgeEmbedding`, `getUnembeddedPRReviews`, `getUnembeddedRepoKnowledge`, `searchSimilarReviews`, `searchSimilarCode`, `searchSimilarDocs`, `searchDocsByTitlePattern`, `upsertDocumentChunks`, `listDocuments`, `deleteDocument`, **and `getSimilarLessons`**. All are deleted from `client.ts` in Step 6.

- [ ] **Step 5: Update startup log line**

Around `src/index.ts:1427`:

Before:
```ts
    console.log(`  - AI API: /api/harvest-data, /api/repo-knowledge, /api/embeddings, /api/pr-analysis, ...`);
```

After:
```ts
    console.log(`  - AI API: /api/harvest-data, /api/repo-knowledge, /api/pr-analysis, /api/resolve-rules, ...`);
```

- [ ] **Step 6: Remove dead helpers from `src/db/client.ts`**

Delete these exported functions (search for each name and delete its full body, including any preceding comment block):

- `insertEmbedding` (line ~488)
- `updateRepoKnowledgeEmbedding` (~500)
- `getUnembeddedPRReviews` (~507)
- `getUnembeddedRepoKnowledge` (~518)
- `searchSimilarReviews` (~530)
- `searchSimilarCode` (~541)
- `getSimilarLessons` (~682) — no remaining caller after Step 3
- `searchSimilarDocs` (~711)
- `searchDocsByTitlePattern` (~724)
- `upsertDocumentChunks` (~741)
- `listDocuments` (~760)
- `deleteDocument` (~773)

- [ ] **Step 7: Simplify `insertReviewLessons`**

Around `src/db/client.ts:651`, replace the entire function:

Before:
```ts
export async function insertReviewLessons(
  prUrl: string,
  aiReview: any,
  peerComments: any[],
  lessons: any,
  embedding?: number[],
): Promise<void> {
  if (embedding && embedding.length > 0) {
    await pool.query(`
      INSERT INTO ai_review_lessons (pr_url, ai_review_json, peer_comments_json, lessons_json, embedding, created_at)
      VALUES ($1, $2, $3, $4, $5::vector, NOW())
      ON CONFLICT (pr_url) DO UPDATE SET
        ai_review_json = $2, peer_comments_json = $3, lessons_json = $4, embedding = $5::vector, created_at = NOW()
    `, [prUrl, aiReview, peerComments, lessons, `[${embedding.join(',')}]`]);
  } else {
    await pool.query(`
      INSERT INTO ai_review_lessons (pr_url, ai_review_json, peer_comments_json, lessons_json, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (pr_url) DO UPDATE SET
        ai_review_json = $2, peer_comments_json = $3, lessons_json = $4, created_at = NOW()
    `, [prUrl, aiReview, peerComments, lessons]);
  }
}
```

After:
```ts
export async function insertReviewLessons(
  prUrl: string,
  aiReview: any,
  peerComments: any[],
  lessons: any,
): Promise<void> {
  await pool.query(`
    INSERT INTO ai_review_lessons (pr_url, ai_review_json, peer_comments_json, lessons_json, created_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (pr_url) DO UPDATE SET
      ai_review_json = $2, peer_comments_json = $3, lessons_json = $4, created_at = NOW()
  `, [prUrl, aiReview, peerComments, lessons]);
}
```

Note: the `embedding` parameter is gone. Callers were updated in Task 3 and Task 6 Step 2.

- [ ] **Step 8: Remove the `fetchDomainScopedCodeExamples` + `formatCodeExamplesForPrompt` re-exports**

These are still live (used by `/api/domain-code-examples` and prAnalyzer). Keep them. No change this step — explicit no-op for clarity.

- [ ] **Step 9: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add src/index.ts src/db/client.ts
git commit -m "refactor(api, db): remove embedding endpoints + vector-search helpers"
```

---

## Task 6.5: Patch consumers that query the dropped column/table

**Why:** Migration 018 (Task 7) drops `repo_knowledge.embedding` and `pr_embeddings`. Two live code paths still reference them and would break after the migration: `codeContextProvider.ts` filters with `rk.embedding IS NOT NULL`, and the `/pr-monitor harvest-status` command reports a count from `pr_embeddings`.

**Files:**
- Modify: `src/services/codeContextProvider.ts`
- Modify: `src/app.ts`

- [ ] **Step 1: Drop the embedding-not-null filter in `codeContextProvider.ts`**

Open `src/services/codeContextProvider.ts`. Around line 48–59 the query reads:

Before:
```ts
  let query = `
    SELECT
      rk.*,
      cd.name as domain_name,
      cd.display_name as domain_display_name
    FROM repo_knowledge rk
    JOIN code_domains cd ON rk.domain_id = cd.id
    WHERE
      rk.domain_id = ANY($1::int[])
      AND rk.file_path <> ALL($2::text[])
      AND rk.embedding IS NOT NULL
  `;
```

After:
```ts
  let query = `
    SELECT
      rk.*,
      cd.name as domain_name,
      cd.display_name as domain_display_name
    FROM repo_knowledge rk
    JOIN code_domains cd ON rk.domain_id = cd.id
    WHERE
      rk.domain_id = ANY($1::int[])
      AND rk.file_path <> ALL($2::text[])
  `;
```

- [ ] **Step 2: Remove the `pr_embeddings` count from `/pr-monitor harvest-status`**

Open `src/app.ts`. Around lines 279 and 298:

Before (line 279):
```ts
            const embeddingCount = await pool.query('SELECT COUNT(*) as count FROM pr_embeddings');
```

Delete this entire line.

Before (line 298, inside the template string):
```ts
                `• Embeddings: ${embeddingCount.rows[0].count}\n` +
```

Delete this entire line.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. If the compiler complains about unused imports in `app.ts`, remove them.

- [ ] **Step 4: Commit**

```bash
git add src/services/codeContextProvider.ts src/app.ts
git commit -m "fix: remove references to soon-to-be-dropped embedding column/table"
```

---

## Task 7: Create the schema cleanup migration

**Files:**
- Create: `src/db/migrations/018_drop_embedding_artifacts.sql`

- [ ] **Step 1: Write the migration**

Create `src/db/migrations/018_drop_embedding_artifacts.sql` with exactly:

```sql
-- Remove pgvector-backed embedding artifacts after dropping Ollama integration.
-- Keeps the `vector` extension enabled (harmless) and the business columns intact.

-- Embedding index + column on ai_review_lessons
DROP INDEX IF EXISTS idx_ai_review_lessons_embedding;
ALTER TABLE IF EXISTS ai_review_lessons DROP COLUMN IF EXISTS embedding;

-- Embedding index + column on repo_knowledge
DROP INDEX IF EXISTS idx_repo_knowledge_vector;
ALTER TABLE IF EXISTS repo_knowledge DROP COLUMN IF EXISTS embedding;

-- Team documents feature removed
DROP INDEX IF EXISTS idx_team_documents_embedding;
DROP INDEX IF EXISTS idx_team_documents_type;
DROP INDEX IF EXISTS idx_team_documents_source;
DROP TABLE IF EXISTS team_documents;

-- Generic embeddings table removed
DROP INDEX IF EXISTS idx_pr_embeddings_vector;
DROP INDEX IF EXISTS idx_pr_embeddings_type;
DROP TABLE IF EXISTS pr_embeddings;
```

- [ ] **Step 2: Run migration locally (optional but recommended)**

If you have a local Postgres with `DATABASE_URL` set:

```bash
npm run compile && npm run migrate
```

Expected output includes: `Running migration: 018_drop_embedding_artifacts.sql` then `Completed: 018_drop_embedding_artifacts.sql`.

If no local DB, skip and rely on Heroku `release` running it.

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/018_drop_embedding_artifacts.sql
git commit -m "feat(db): migration 018 — drop pgvector embedding artifacts"
```

---

## Task 8: Prune `package.json`, `.env.example`

**Files:**
- Modify: `package.json`
- Modify: `.env.example`

- [ ] **Step 1: Remove the `ollama` runtime dependency**

In `package.json`, delete the line:

```json
    "ollama": "^0.6.3",
```

(commas: ensure surrounding JSON remains valid — remove any trailing comma on the line before the removal if it becomes the last entry).

- [ ] **Step 2: Remove the obsolete scripts**

In `package.json` `"scripts"` block, delete these two lines:

```json
    "embed": "node dist/worker/embeddingPipeline.js",
    "ingest-doc": "node dist/worker/docIngester.js"
```

- [ ] **Step 3: Refresh `package-lock.json`**

Run: `npm install`
Expected: package-lock.json updates to remove `ollama` and its transitives. No errors.

- [ ] **Step 4: Remove Ollama section from `.env.example`**

Delete lines 45–47 of `.env.example`:

```
# Ollama Configuration (for embeddings only)
OLLAMA_HOST=http://localhost:11434
OLLAMA_EMBED_MODEL=nomic-embed-text
```

- [ ] **Step 5: Verify no stale references**

Run:
```bash
grep -rn --include='*.ts' --include='*.json' --include='*.example' -i 'ollama\|nomic' .
```
Expected: zero matches under `src/`, `worker/`, `scripts/`, `package.json`, `package-lock.json`, `.env.example`. (`node_modules/` / `dist/` may still have stale entries — that's fine pre-compile.)

- [ ] **Step 6: Clean stale `dist/` artifacts**

`npm run compile` runs `tsc` + copies migrations, but does not delete files that no longer exist in source. Remove the orphaned compiled files so no process can accidentally load them:

```bash
rm -f \
  dist/worker/embeddingPipeline.js dist/worker/embeddingPipeline.js.map dist/worker/embeddingPipeline.d.ts dist/worker/embeddingPipeline.d.ts.map \
  dist/worker/docIngester.js dist/worker/docIngester.js.map dist/worker/docIngester.d.ts dist/worker/docIngester.d.ts.map \
  dist/src/services/embeddingService.js dist/src/services/embeddingService.js.map dist/src/services/embeddingService.d.ts dist/src/services/embeddingService.d.ts.map \
  dist/src/services/reviewGenerator.js dist/src/services/reviewGenerator.js.map dist/src/services/reviewGenerator.d.ts dist/src/services/reviewGenerator.d.ts.map \
  dist/src/services/reviewerSuggester.js dist/src/services/reviewerSuggester.js.map dist/src/services/reviewerSuggester.d.ts dist/src/services/reviewerSuggester.d.ts.map \
  dist/src/services/vectorSearch.js dist/src/services/vectorSearch.js.map dist/src/services/vectorSearch.d.ts dist/src/services/vectorSearch.d.ts.map
```

Expected: no error (globs that miss are no-ops with `-f`).

- [ ] **Step 7: Compile check**

Run: `npm run compile`
Expected: succeeds; `dist/` rebuilt without Ollama bundles.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore: drop ollama dep, embed/ingest-doc scripts, OLLAMA_* env"
```

---

## Task 9: Update `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the architecture diagram**

Find the ASCII diagram at `README.md:18-37`. Replace the entire block (including the fences) with:

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Slack Channel  │────▶│  Heroku App      │────▶│  PostgreSQL     │
│  (PR Links)     │     │  (Node.js/Bolt)  │     │  (Tracked PRs)  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                 ▲
                                 │ API
                                 ▼
                        ┌──────────────────┐     ┌─────────────────┐
                        │  Local Worker    │────▶│ GitHub Enterprise│
                        │  (Your Laptop)   │     │ (VPN Required)   │
                        └──────────────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  Claude AI       │
                        │  (chat + review) │
                        └──────────────────┘
```

- [ ] **Step 2: Replace line 39**

Before:
```
The local worker runs on your VPN-connected laptop to check PR status from internal GitHub Enterprise servers, then reports the status back to Heroku. AI reviews are generated via **Claude AI API** (Anthropic), while embeddings are generated locally via **Ollama** (nomic-embed-text).
```

After:
```
The local worker runs on your VPN-connected laptop to check PR status from internal GitHub Enterprise servers, then reports the status back to Heroku. AI reviews are generated via **Claude AI API** (Anthropic). Semantic retrieval has been removed; reviewer suggestions and code context use deterministic file-path + ontology matching.
```

- [ ] **Step 3: Remove Ollama from the prerequisites list**

Delete line 49:
```
- **Ollama** — running locally for embeddings (`ollama pull nomic-embed-text`)
```

- [ ] **Step 4: Remove the `Ollama (required for embeddings only)` env block**

Delete lines 183–187 inside the local `.env` example block:

```
   # Ollama (required for embeddings only)
   OLLAMA_HOST=http://localhost:11434
   OLLAMA_EMBED_MODEL=nomic-embed-text
```

- [ ] **Step 5: Remove the `embeddingService.ts` / `embeddingPipeline.ts` / `docIngester.ts` lines from Project Structure**

Inside the `## Project Structure` section, delete these tree lines:

```
│   │   ├── embeddingService.ts   # Ollama embedding generation (nomic-embed-text)
...
│   │   └── vectorSearch.ts       # Vector similarity search (legacy, retained for review search)
...
│   ├── embeddingPipeline.ts      # Embedding generation pipeline (Ollama)
│   └── docIngester.ts            # Documentation ingestion + embedding
```

And delete the `reviewGenerator.ts`, `reviewerSuggester.ts` entries while you're there (deleted in Task 5).

- [ ] **Step 6: Remove the `OLLAMA_HOST` / `OLLAMA_EMBED_MODEL` rows from the env-var table**

Delete lines 390–391:
```
| `OLLAMA_HOST` | Ollama server URL for embeddings (default: `http://localhost:11434`) |
| `OLLAMA_EMBED_MODEL` | Ollama embedding model (default: `nomic-embed-text`) |
```

- [ ] **Step 7: Remove now-invalid npm script mentions**

In the Scripts table (around lines 342–357), delete the rows for `embed`, `map-users` (confirm first — keep if still relevant), and any mention of `ingest-doc`. Actually, only remove rows for `embed` and `ingest-doc`. Leave `map-users`, `harvest`, etc.

- [ ] **Step 8: Commit**

```bash
git add README.md
git commit -m "docs(readme): remove Ollama from setup, diagram, env, scripts"
```

---

## Task 10: Update `CLAUDE.md` and `docs/*.md`

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/architecture.md`
- Modify: `docs/database.md`
- Modify: `docs/services.md`
- Modify: `docs/api-endpoints.md`
- Modify: `docs/workers.md`
- Modify: `docs/environment.md`

- [ ] **Step 1: Patch `CLAUDE.md`**

Edit `CLAUDE.md` line 16 — remove "Ollama" from the bullet:

Before:
```
2. **Local VPN worker** (`worker/`) — runs on a laptop on VPN. Pulls work from Heroku via HTTP, calls GHE + Claude + Ollama, posts results back.
```

After:
```
2. **Local VPN worker** (`worker/`) — runs on a laptop on VPN. Pulls work from Heroku via HTTP, calls GHE + Claude, posts results back.
```

Delete line 46 (entire bullet):
```
- **Ollama stays local, Claude goes remote.** Ollama only does embeddings (768-dim `nomic-embed-text`); Claude does all LLM chat. Do not reintroduce Ollama for generation.
```

Delete the "Pgvector dimension is 768 everywhere" bullet (next line after what was line 46).

- [ ] **Step 2: Patch `docs/architecture.md`**

Remove Ollama from the topology diagram — delete the line:
```
│    • Ollama (localhost:11434) for embeddings only        │
```

In section §3, replace the sub-step:
```
2. Ollama-embed the diff → `POST /api/search-similar-reviews` for RAG context.
```
with:
```
2. (Removed — semantic vector search was dropped with the Ollama integration.)
```

In §4, remove the embedding steps (Steps 2, 3, and the file-fingerprint embedding in Step 4). Replace with a note that the pipeline now relies on the deterministic `fetchDomainScopedCodeExamples` plus the recency-only `/api/ai-learning-context` GET fallback.

Delete the "Don't use Ollama for chat" line at the bottom ("What *not* to do").

- [ ] **Step 3: Patch `docs/database.md`**

Replace the opening two paragraphs (the preamble starting "Postgres (Heroku-managed)...") with:

```
Postgres (Heroku-managed). The `vector` extension is enabled (migration 007) but no vector columns remain after migration 018. Single connection pool at `src/db/client.ts:3-6` — uses `ssl: { rejectUnauthorized: false }` when `NODE_ENV=production`, otherwise SSL is disabled.
```

In the table catalog, mark the following as removed (strike or delete whole subsections):
- `pr_embeddings` — "Removed in migration 018."
- `team_documents` — "Removed in migration 018."
- `repo_knowledge.embedding` — delete the row from that table's column list.
- `ai_review_lessons.embedding` — delete the row.

Remove the entire "pgvector patterns" section. Replace with one line: "pgvector is no longer used; see migration 018."

In the `src/db/client.ts` API catalog, delete every entry for a function you removed in Task 6 Step 6 (list of 12 functions).

- [ ] **Step 4: Patch `docs/services.md`**

Delete the whole sections for:
- `embeddingService.ts`
- `reviewGenerator.ts`
- `reviewerSuggester.ts`
- `vectorSearch.ts`

Edit the `claudeClient.ts` section: no longer need the sentence "Ollama only does embeddings" — it's already implicit.

- [ ] **Step 5: Patch `docs/api-endpoints.md`**

Delete the whole sections:
- "Vector search (used by `prAnalyzer`)" (table of 4 endpoints)
- "Embeddings" (table of 4 endpoints)
- "Team documents (RAG over design docs)" (table of 5 endpoints)

In the "Analysis lifecycle" section, delete the `/api/ai-learning-context` entry's mention of the POST-with-embedding branch. Replace with: "GET or POST; both return `{lessons, feedback}` from recency lookup only."

Update the "Feedback + learning" table row for `/api/ai-lessons` to drop the `embedding?` field from the body schema.

- [ ] **Step 6: Patch `docs/workers.md`**

Delete the entire entries for `worker/embeddingPipeline.ts` and `worker/docIngester.ts`.

In the `worker/prAnalyzer.ts` entry, remove the line "Ollama-embed the diff" and remove "Ollama" from the env list. Same for `worker/testReview.ts`, `worker/bootstrapLearner.ts`, `worker/reviewLearner.ts` wherever Ollama appears.

In the deployment-matrix table at the bottom, delete the `embeddingPipeline` and `docIngester` rows and strip "Ollama" from any status cells.

- [ ] **Step 7: Patch `docs/environment.md`**

In the "Optional" table, delete the two rows:

```
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama base URL for embeddings. |
| `OLLAMA_EMBED_MODEL` | `nomic-embed-text` | Ollama model — must produce 768-dim vectors. |
```

In the "Dependencies (runtime)" table, delete the `ollama` row.

- [ ] **Step 8: Final sweep**

Run: `grep -rn -i "ollama\|nomic\|pgvector\|vector(768)\|pr_embeddings\|team_documents" CLAUDE.md docs/ README.md`

Expected: zero matches except possibly historical references inside migration SQL files (migrations/*.sql) and intentional "no longer used" / "Removed in migration 018" statements in docs/database.md. If any live claim remains, fix it.

- [ ] **Step 9: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "docs: scrub Ollama + pgvector references across CLAUDE.md and docs/"
```

---

## Task 11: End-to-end smoke verification

**Files:** (none modified — verification only)

- [ ] **Step 1: Full compile check**

Run: `npm run compile`
Expected: no TS errors; `dist/` rebuilt.

- [ ] **Step 2: Startup check (local)**

Requires local `.env` with Slack + DB set. Run:

```bash
npm run dev
```

Expected: logs include `[Socket Mode] PR Review Reminder bot started` and `HTTP server listening on port 3000`. Cancel with Ctrl-C after ~5s if it connects.

- [ ] **Step 3: Migration check**

If you have a local DB:

```bash
psql "$DATABASE_URL" -c "\dt" | grep -E 'pr_embeddings|team_documents'
```
Expected: empty output (tables dropped).

```bash
psql "$DATABASE_URL" -c "\d repo_knowledge" | grep embedding
psql "$DATABASE_URL" -c "\d ai_review_lessons" | grep embedding
```
Expected: no match (columns dropped).

- [ ] **Step 4: Dry-run the AI review on a known PR**

Pick a PR URL and run:

```bash
npm run test-review -- <pr-url>
```

Expected:
- No `Ollama not ready` line.
- No `Embedding dimensions` line.
- Pass 1/2/3 still execute.
- Claude posts comments; reviewer suggestions appear if reviewers are mapped.

- [ ] **Step 5: Confirm endpoint removals**

If you have the Heroku app running locally (or a staging app), hit a removed endpoint:

```bash
curl -s -H "X-Worker-API-Key: $WORKER_API_KEY" \
  -X POST "$LOCAL_API/api/search-similar-reviews" \
  -H 'Content-Type: application/json' \
  -d '{"embedding":[]}'
```

Expected: `{"error":"Not Found"}` with HTTP 404.

- [ ] **Step 6: Final grep**

```bash
grep -rn -i --include='*.ts' --include='*.json' --include='*.md' --include='*.example' --include='*.sql' 'ollama\|nomic-embed-text\|OLLAMA_' . | grep -v node_modules | grep -v dist/
```

Expected: zero live-code matches. Only permissible matches: historical migration SQL text inside migration files, and "Removed in migration 018" strings in docs.

- [ ] **Step 7: Commit nothing (verification only)**

No commit. If everything above is green, the plan is done.

---

## Task 12: Heroku deploy playbook (post-merge checklist)

**Files:** (none — operational notes)

**Critical sequencing:** Deploy Heroku FIRST, confirm health, THEN restart workers. A laptop running an old `worker:watch` against the new Heroku will send unused `embedding` fields in POST bodies — the new API simply ignores them, so old workers keep functioning until re-pulled. The reverse (old Heroku + new worker) would not happen because workers can't deploy before the merge.

- [ ] **Step 1: Pre-deploy data sanity check**

Confirm no non-embedding data in the tables we're about to drop. Any hit here indicates unexpected usage and should halt the deploy:

```bash
heroku pg:psql -a <your-app-name> -c \
  "SELECT COUNT(*) AS rows, COUNT(DISTINCT content_type) AS distinct_types FROM pr_embeddings;"

heroku pg:psql -a <your-app-name> -c \
  "SELECT doc_type, COUNT(*) FROM team_documents GROUP BY doc_type ORDER BY 2 DESC LIMIT 10;"
```

Expected (safe): `pr_embeddings` / `team_documents` either empty, or only the known content types (`pr_review`) / `doc_type` values (`design`, `requirements`, `runbook`, `codebase-knowledge`). Any row is lost on migration 018 — do not proceed if rows contain data the team cannot re-derive.

- [ ] **Step 2: Pre-deploy Heroku config cleanup**

```bash
heroku config:unset OLLAMA_HOST OLLAMA_EMBED_MODEL -a <your-app-name>
```

Expected: both vars unset — harmless if they were never set.

- [ ] **Step 3: Deploy**

```bash
git push heroku main
```

Expected: `release` step runs `npm run migrate` which applies migration 018 (drops `pr_embeddings`, `team_documents`, two `embedding` columns, four IVFFlat indexes). `web` restarts. If `release` fails, Heroku does **not** boot the new web dyno — the old build stays serving, which is the correct failure mode.

- [ ] **Step 4: Post-deploy health check**

```bash
curl -s https://<your-app-name>.herokuapp.com/health
# Confirm the new code: hit a removed endpoint — should be 404
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "X-Worker-API-Key: $(heroku config:get WORKER_API_KEY -a <your-app-name>)" \
  -X POST https://<your-app-name>.herokuapp.com/api/search-similar-reviews \
  -H 'Content-Type: application/json' -d '{"embedding":[]}'
```

Expected: `{"status":"ok","app":"pr-review-reminder"}` and HTTP `404` for the removed endpoint.

- [ ] **Step 5: Worker laptop cleanup**

On the VPN laptop, after the health check in Step 4 succeeds:

```bash
# Stop the current worker loop (e.g., Ctrl-C in the terminal running worker:watch,
# or: launchctl unload ~/Library/LaunchAgents/com.pr-worker.plist)

# Optional: free disk by removing the embedding model
ollama rm nomic-embed-text 2>/dev/null || true

# Pull and rebuild
git pull
npm install
npm run compile

# Restart the worker
npm run worker:watch
```

Expected: the worker polls every 5 min, reports PR status, spawns prAnalyzer for new PRs without any `Ollama not ready` or `Embedding dimensions` log lines.

- [ ] **Step 6: Rollback plan (reference only, do not run)**

If the release fails catastrophically, Heroku's automatic rollback keeps the previous build running. Manually:

```bash
heroku releases -a <your-app-name>   # find last green release vNN
heroku rollback vNN -a <your-app-name>
```

Caveat: rollback does **not** restore the dropped columns/tables. If you rollback, the **old code still references `pr_embeddings`** (via `/pr-monitor harvest-status` before the Task 6.5 patch) and will 500 on that command. To restore data safely, run the equivalent of migration 008/013 manually via `heroku pg:psql`, then rollback. Treat this migration as effectively forward-only.

---

## Self-Review

Running the checklist from the writing-plans skill, plus the post-review patches.

**Spec coverage** (13 tasks total, including Task 6.5 added after subagent review):
- ✅ Ollama removed from 3 review workers (Tasks 1–3)
- ✅ 2 Ollama-only workers + dead service deleted (Task 4)
- ✅ Legacy dead services cleaned up (Task 5)
- ✅ 9 HTTP endpoints removed + 12 DB helpers deleted (Task 6)
- ✅ `codeContextProvider` and `/pr-monitor harvest-status` patched so migration 018 doesn't break them (**Task 6.5**)
- ✅ Schema migration drops `pr_embeddings`, `team_documents`, 2 vector columns, 4 IVFFlat indexes (Task 7)
- ✅ `package.json`, `.env.example`, stale `dist/` artifacts scrubbed (Task 8)
- ✅ `README.md` updated (Task 9)
- ✅ `CLAUDE.md` + 6 docs updated (Task 10)
- ✅ Smoke + deploy verification with pre-deploy data sanity + rollback note (Tasks 11–12)

**Placeholder scan**: None. Every step names exact files and exact content to change.

**Type consistency**:
- `insertReviewLessons` signature: 4 params everywhere after Task 6 Step 7 (Task 3 Step 5 stops sending a 5th, Task 6 Step 2 stops receiving a 5th).
- `fetchLearningContext()`: no-arg everywhere after Tasks 1/2/3 Step 4.
- `reportLessons`: 4 params everywhere after Task 3 Steps 5 + 7.
- `buildUserPrompt` in bootstrapLearner: 4 params everywhere after Task 3 Steps 6 + 7.
- `getSimilarLessons`: deleted from `client.ts` (Task 6 Step 6) and from `index.ts` imports (Task 6 Step 4); final call site removed in Task 6 Step 3.

**Reviewer issues addressed**:
- `src/services/codeContextProvider.ts:58` `AND rk.embedding IS NOT NULL` → removed in Task 6.5 before migration runs.
- `src/app.ts:279,298` `pr_embeddings` count → removed in Task 6.5.
- `getSimilarLessons` orphan → delete added to Task 6 Step 6 and `index.ts` handler rewrite pinned in Task 6 Step 3.
- Stale `dist/` files for 6 deleted source files → cleaned in Task 8 Step 6.
- Pre-deploy data check + explicit rollback caveat → Task 12 Steps 1 and 6.

**Known caveats**:
- Tasks 4 and 5 delete files based on grep evidence. If a new import was added between plan creation and execution, Step 1 of each task will catch it.
- Task 10 docs surgery is text-heavy; do it carefully with Edit, not Write.
- No test framework exists — verification is a smoke test + typecheck + greps.
- Migration 018 is effectively forward-only. If rollback is needed, manually recreate the dropped tables/columns before `heroku rollback` — noted in Task 12 Step 6.
