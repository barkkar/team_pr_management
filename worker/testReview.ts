#!/usr/bin/env npx ts-node
/**
 * Test Review (dry-run)
 *
 * Runs the full AI review pipeline for a given PR URL and logs results
 * to the console. Nothing is saved to the database or posted to Slack.
 *
 * Usage:
 *   npm run test-review -- https://git.soma.salesforce.com/org/repo/pull/123
 *   npm run test-review -- https://... --no-mention          # suppress reviewer @mentions
 *   npm run test-review -- https://... --post --channel=C123  # post to Slack
 *   npm run test-review -- https://... --post --channel=C123 --no-mention
 */

import 'dotenv/config';
import axios from 'axios';
import { requireTokenForHost } from '../src/utils/gheTokenResolver';
import { claudeChat, checkClaudeHealth, getClaudeModel } from '../src/services/claudeClient';

const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;

function log(message: string): void {
  console.log(`[TestReview] ${message}`);
}

function logError(message: string): void {
  console.error(`[TestReview] ERROR: ${message}`);
}

function herokuHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Worker-API-Key': WORKER_API_KEY!,
  };
}

function extractHostname(prUrl: string): string | null {
  const match = prUrl.match(/https:\/\/([a-zA-Z0-9.-]+)/);
  return match ? match[1] : null;
}

function separator(title: string): void {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

// ---------------------------------------------------------------------------
// GHE API
// ---------------------------------------------------------------------------

async function fetchPRDetails(hostname: string, org: string, repo: string, prNumber: number): Promise<any> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      timeout: 15000,
    },
  );
  return response.data;
}

async function fetchPRDiff(hostname: string, org: string, repo: string, prNumber: number): Promise<string> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3.diff',
      },
      timeout: 30000,
    },
  );
  return response.data || '';
}

async function fetchPRFiles(hostname: string, org: string, repo: string, prNumber: number): Promise<any[]> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/files`,
    {
      params: { per_page: 100 },
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      timeout: 15000,
    },
  );
  return response.data || [];
}

// ---------------------------------------------------------------------------
// Skill-based routing: keyword → doc title patterns (derived from skill.md)
// ---------------------------------------------------------------------------

const SKILL_ROUTING: { keywords: RegExp; docPattern: string; area: string }[] = [
  { keywords: /\b(UDD|EntityObject|EntityFunctions|EntityDef|EntityRecord|SOQL|entity[.\-_]xml|object[.\-_]definition|field[.\-_]label|shared[.\-_]labels|CustomObject|CustomField|StandardEntity)\b/i,
    docPattern: 'core-engineer/entity-engineer/%', area: 'Entity/UDD' },
  { keywords: /\b(SDB|SFSQL|PLSQL|psql|db[.\-_]schema|stored[.\-_]procedure|database[.\-_]migration|\.sql)\b/i,
    docPattern: 'core-engineer/db-engineer/%', area: 'Database' },
  { keywords: /\b(ftest|functional[.\-_]test|EntityEnabler|PublicEntityTest|AccessBasedEntityEnablerList|OldTestSuiteEntityAllowList|CRUD[.\-_]test)\b/i,
    docPattern: 'core-engineer/test-engineer/%', area: 'Testing' },
  { keywords: /\b(bazel|buildifier|BUILD\.bazel|db[.\-_]schema[.\-_]update|app[.\-_]server|graph[.\-_]tool)\b/i,
    docPattern: 'core-engineer/infra-engineer/%', area: 'Infrastructure' },
  { keywords: /\b(message[.\-_]queue|MQ[.\-_]handler|async[.\-_]handler|background[.\-_]processing|cron[.\-_]job|scheduled[.\-_]task|QueueableJob|BatchableJob)\b/i,
    docPattern: 'core-engineer/async-engineer/%', area: 'Async/Scheduled' },
  { keywords: /\b(org[.\-_]permission|user[.\-_]permission|feature[.\-_]flag|pilot[.\-_]gate|license[.\-_]check|SKU|access[.\-_]control|PLD)\b/i,
    docPattern: 'core-engineer/permission-engineer/%', area: 'Permissions' },
  { keywords: /\b(LogRecordType|structured[.\-_]logging|app[.\-_]logging[.\-_]format)\b/i,
    docPattern: 'core-engineer/logrecord-engineer/%', area: 'Logging' },
  { keywords: /\b(SpringConfiguration|@Configuration|@Bean|@Import|dependency[.\-_]injection|API[.\-_]Impl|module[.\-_]descriptor)\b/i,
    docPattern: 'core-engineer/module-engineer/%', area: 'Modules' },
  { keywords: /\b(git[.\-_]commit|git[.\-_]push|create[.\-_]PR|p4[.\-_]submit|check[.\-_]in[.\-_]code|submit[.\-_]for[.\-_]review)\b/i,
    docPattern: 'core-engineer/git-engineer/%', area: 'Git' },
];

function matchSkillRoutes(text: string): { patterns: string[]; areas: string[] } {
  const patterns: string[] = [];
  const areas: string[] = [];
  for (const route of SKILL_ROUTING) {
    if (route.keywords.test(text)) {
      patterns.push(route.docPattern);
      areas.push(route.area);
    }
  }
  return { patterns, areas };
}

// ---------------------------------------------------------------------------
// GHE: fetch full file content for context
// ---------------------------------------------------------------------------

async function fetchFileContent(
  hostname: string, org: string, repo: string, filePath: string, ref: string,
): Promise<string | null> {
  try {
    const token = requireTokenForHost(hostname);
    const response = await axios.get(
      `https://${hostname}/api/v3/repos/${org}/${repo}/contents/${filePath}`,
      {
        params: { ref },
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
        timeout: 10000,
      },
    );
    if (response.data.encoding === 'base64') {
      return Buffer.from(response.data.content, 'base64').toString('utf-8');
    }
    return response.data.content || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Heroku API (read-only queries)
// ---------------------------------------------------------------------------

async function fetchOntologyRules(
  changedFiles: string[], diffText: string,
): Promise<{ rules: any[]; taxonomy: any[]; unmatched_files: string[] }> {
  try {
    const response = await axios.post(
      `${HEROKU_API_URL}/api/resolve-rules`,
      { changed_files: changedFiles, diff_text: diffText.substring(0, 50000) },
      { headers: herokuHeaders(), timeout: 30000 },
    );
    return {
      rules: response.data.rules || [],
      taxonomy: response.data.taxonomy || [],
      unmatched_files: response.data.unmatched_files || [],
    };
  } catch (error: any) {
    log(`  Ontology rule resolution failed: ${error.message}`);
    return { rules: [], taxonomy: [], unmatched_files: changedFiles };
  }
}

async function classifyUnmatchedFilesViaLLM(
  unmatchedFiles: string[], diffText: string, taxonomy: any[],
): Promise<any[]> {
  if (unmatchedFiles.length === 0 || taxonomy.length === 0) return [];

  const domainsWithRules = taxonomy.filter((d: any) => d.rule_count > 0);
  if (domainsWithRules.length === 0) return [];

  const taxonomyText = domainsWithRules
    .map((d: any) => `${'  '.repeat(d.depth)}${d.id}: ${d.display_name}${d.description ? ' — ' + d.description : ''} (${d.rule_count} rules)`)
    .join('\n');

  const fileDiffs = diffText.split(/^(?=diff --git )/m);
  const unmatchedSet = new Set(unmatchedFiles);
  const relevantDiff = fileDiffs
    .filter(fd => {
      const pathMatch = fd.match(/diff --git a\/(\S+)/);
      return pathMatch && unmatchedSet.has(pathMatch[1]);
    })
    .join('')
    .substring(0, 6000);

  if (!relevantDiff.trim()) return [];

  const prompt = `You are a code classifier. Given a code diff, determine which coding rule domains apply.

DOMAINS (id: name — description):
${taxonomyText}

FILES: ${unmatchedFiles.join(', ')}
DIFF:
${relevantDiff}

Respond with ONLY a JSON object: {"domain_ids": [1, 2, 3]}
If no domains apply, respond with {"domain_ids": []}`;

  try {
    const text = await claudeChat(undefined, prompt, {
      maxTokens: 100,
      temperature: 0.1,
      jsonMode: true,
    });

    const parsed = JSON.parse(text);
    const ids: number[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.domain_ids)
        ? parsed.domain_ids
        : [];

    const validIds = new Set(domainsWithRules.map((d: any) => d.id));
    const classifiedIds = ids.filter((id: number) => typeof id === 'number' && validIds.has(id));

    if (classifiedIds.length > 0) {
      log(`  LLM classified unmatched files into domains: ${classifiedIds.join(', ')}`);
    }
    return classifiedIds;
  } catch (error: any) {
    log(`  LLM classification failed: ${error.message}`);
    return [];
  }
}

async function fetchSuggestedReviewers(filePaths: string[], prAuthor: string): Promise<any[]> {
  const response = await axios.post(
    `${HEROKU_API_URL}/api/suggested-reviewers`,
    { file_paths: filePaths, pr_author: prAuthor },
    { headers: herokuHeaders(), timeout: 30000 },
  );
  return response.data.reviewers || [];
}

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

// ---------------------------------------------------------------------------
// LLM Prompts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Multi-pass review helpers
// ---------------------------------------------------------------------------

const TEST_FILE_PATTERN = /(__tests__|test\.js|test\.ts|\.test\.|Test\.java|\/test\/func\/)/i;
const SKIP_FILE_PATTERN = /(\.utam\.json|\.stories\.js|-meta\.xml)$/i;

/**
 * Split diff into implementation files and test files.
 * New files are reordered to appear first within each group.
 */
function splitDiff(diff: string): { implDiff: string; testDiff: string; implFiles: string[]; testFiles: string[] } {
  const fileDiffs = diff.split(/^(?=diff --git )/m);
  const implNew: string[] = [];
  const implMod: string[] = [];
  const testNew: string[] = [];
  const testMod: string[] = [];
  const implFiles: string[] = [];
  const testFiles: string[] = [];

  for (const fd of fileDiffs) {
    if (!fd.trim()) continue;
    const pathMatch = fd.match(/diff --git a\/(\S+)/);
    const filePath = pathMatch ? pathMatch[1] : '';
    const isNew = fd.includes('new file mode') || fd.includes('--- /dev/null');
    const isSkip = SKIP_FILE_PATTERN.test(filePath);
    const isTest = TEST_FILE_PATTERN.test(filePath);

    if (isSkip) {
      // Skip metadata files (utam, stories, meta-xml) — not worth reviewing
      continue;
    } else if (isTest) {
      testFiles.push(filePath);
      (isNew ? testNew : testMod).push(fd);
    } else {
      implFiles.push(filePath);
      (isNew ? implNew : implMod).push(fd);
    }
  }

  return {
    implDiff: [...implNew, ...implMod].join(''),
    testDiff: [...testNew, ...testMod].join(''),
    implFiles,
    testFiles,
  };
}

function buildLearningContextBlock(learningContext?: { lessons: any[]; feedback: any[] }): string {
  if (!learningContext) return '';
  const { lessons, feedback } = learningContext;
  if (lessons.length === 0 && feedback.length === 0) return '';

  const parts: string[] = ['\nLEARNING FROM PAST REVIEWS — You MUST apply these lessons to THIS PR:'];
  for (const l of lessons.slice(0, 3)) {
    const lj = typeof l.lessons_json === 'string' ? JSON.parse(l.lessons_json) : l.lessons_json;
    for (const pattern of (lj.patterns || []).slice(0, 3)) {
      parts.push(`- Review pattern: ${pattern}`);
    }
    for (const takeaway of (lj.key_takeaways || []).slice(0, 2)) {
      parts.push(`- Lesson: ${takeaway}`);
    }
    for (const missed of (lj.missed_issues || []).slice(0, 2)) {
      const cat = missed.category ? ` [${missed.category}]` : '';
      const file = missed.file_path ? ` in ${missed.file_path}` : '';
      parts.push(`- Previously missed${cat}${file}: ${missed.issue || missed}`);
    }
    for (const spot of (lj.review_blind_spots || []).slice(0, 3)) {
      parts.push(`- Blind spot category: ${spot}`);
    }
    if (lj.key_takeaway && !lj.key_takeaways) parts.push(`- Lesson: ${lj.key_takeaway}`);
    for (const missed of (lj.ai_missed || []).slice(0, 2)) {
      parts.push(`- Previously missed: ${missed}`);
    }
  }
  for (const f of feedback.slice(0, 2)) {
    const prefix = f.rating === 'helpful' ? 'Team found helpful' : 'Team found unhelpful';
    parts.push(`- ${prefix}: "${(f.feedback_text || '').substring(0, 200)}"`);
  }
  return parts.join('\n');
}

const JSON_SCHEMA = '\nRespond with JSON: {"summary": "...", "comments": [{"file_path": "...", "line_hint": "...", "comment": "...", "type": "comment|question|suggestion", "severity": "critical|high|medium|low", "reason": "1-sentence why this matters", "suggested_fix": "(optional) diff snippet", "source": "(optional) rule or context citation"}]}';

// --- Pass 1: Implementation code review (bugs, logic, security, naming) ---

function pass1_systemPrompt(fileCount: number): string {
  const minComments = Math.max(2, Math.min(fileCount, 8));
  return `You are an expert code reviewer reviewing IMPLEMENTATION files only (no test files). Respond with valid JSON only.

{"summary": "1-2 sentence assessment", "comments": [{"file_path": "path/to/file", "line_hint": "line 42", "comment": "your comment", "type": "suggestion", "severity": "high", "reason": "1-sentence why this matters", "suggested_fix": "- if (val) {\n+ if (val != null) {", "source": "Learning context takeaway"}]}

Severity classification (REQUIRED for every comment):
- "critical": security hole, crash risk, race condition, data loss
- "high": bug, logic flaw, null dereference, performance pitfall
- "medium": readability, maintainability, anti-pattern, missing docs
- "low": style nit, minor optimization, trivial suggestion

Context & evidence (REQUIRED):
- "reason" (REQUIRED): One sentence explaining what breaks, what risk exists, or what improves. Be specific.
- "suggested_fix" (optional): Include ONLY for small, self-contained fixes (null check, guard clause, missing import, rename). Format as unified diff: "-" for removed lines, "+" for added lines. Max 6 lines. Do NOT include for architectural concerns or complex refactors.
- "source" (optional): Cite what informed the comment — e.g. a learning context takeaway or a coding-rule title.

Rules:
- type: "comment", "question", or "suggestion"
- severity: MUST be one of "critical", "high", "medium", "low"
- Focus on: bugs, security, performance, logic errors, edge cases, error handling, null checks, accessibility
- NEVER write vague comments. These phrases are BANNED: "ensure this is correct", "consider using", "not properly handling", "add validation", "could be improved", "not properly scoped". Instead say EXACTLY what is wrong: what input causes what failure
- Do NOT suggest renaming variables or elements for "readability" — skip trivial style/naming issues
- Do NOT comment on CSS scoping — LWC components use shadow DOM which auto-scopes CSS
- Do NOT repeat the same comment pattern across different files. Each comment must be unique
- ONLY use file_path values from the provided file list. Do NOT invent or guess file paths
- Maximum 3 comments per file
- You MUST return at least ${minComments} comments spread across different files
- For each file: look for missing error handling, null/undefined access, security issues, logic bugs, race conditions, missing edge cases`;
}

function pass1_userPrompt(
  prTitle: string, implDiff: string, implFiles: string[],
  learningContext?: { lessons: any[]; feedback: any[] },
): string {
  const parts: string[] = [];
  parts.push(`Review these IMPLEMENTATION files from PR: "${prTitle}"`);
  parts.push(`\nFiles: ${implFiles.join(', ')}`);
  parts.push(buildLearningContextBlock(learningContext));
  parts.push(`\nDiff:\n${implDiff.substring(0, 28000)}`);
  parts.push(JSON_SCHEMA);
  return parts.join('\n');
}

// --- Pass 2: Ontology rules compliance check ---

function pass2_systemPrompt(): string {
  return `You are a compliance reviewer checking implementation code against exact coding rules from the team's ontology. Respond with valid JSON only.

{"summary": "1-2 sentence compliance assessment", "comments": [{"file_path": "path/to/file", "line_hint": "line 15", "comment": "your comment", "type": "suggestion", "severity": "high", "reason": "1-sentence why this matters", "suggested_fix": "- oldCode\n+ fixedCode", "source": "[Rule Title] (rule_key)"}]}

Severity classification (REQUIRED for every comment):
- "critical": security violation, auth bypass, data exposure
- "high": rule violation that causes bugs or breaking changes
- "medium": missing recommended pattern, incomplete compliance
- "low": minor deviation from rule

Context & evidence (REQUIRED):
- "reason" (REQUIRED): One sentence explaining what breaks or what risk exists if the rule is not followed.
- "suggested_fix" (optional): Include for simple compliance fixes (missing import, wrong pattern, missing guard). Unified diff format, max 6 lines.
- "source" (REQUIRED): MUST cite the rule title and key in brackets, e.g. "[Entity Field Validation] (entity.field.must_have_help_text)". This is mandatory for every compliance comment.

Rules:
- Each CODING RULE below is exact and deterministic — it was matched to this PR's files and code patterns
- For each rule, check if the implementation code follows it
- If the code VIOLATES a rule, cite the rule title and key and explain what's wrong
- If the code MISSES a required pattern from a rule, call it out
- Use the rule's severity as a baseline for your comment severity
- NEVER write vague comments. Be specific: "Per [rule title], you must X but the code does Y"
- Only comment on genuine violations — do not force-fit unrelated rules
- If no rules are violated, return {"summary": "No rule violations found", "comments": []}`;
}

function pass2_userPrompt(
  prTitle: string, implDiff: string, implFiles: string[], rules: any[],
): string {
  const parts: string[] = [];
  parts.push(`Check this PR against coding rules: "${prTitle}"`);
  parts.push(`\nFiles: ${implFiles.join(', ')}`);
  parts.push('\nCODING RULES — check the code against each of these exact rules:');
  for (const rule of rules.slice(0, 15)) {
    const severityTag = rule.severity ? `[${rule.severity.toUpperCase()}]` : '';
    const domain = rule.domain_display_name || rule.domain_name || '';
    const matchedVia = rule.matched_via ? ` (matched via: ${rule.matched_via})` : '';
    parts.push(`--- [${rule.title}] (${rule.rule_key}) ${severityTag} domain:${domain}${matchedVia} ---`);
    parts.push(rule.description.substring(0, 1000));
    parts.push('---');
  }
  parts.push(`\nDiff:\n${implDiff.substring(0, 20000)}`);
  parts.push(JSON_SCHEMA);
  return parts.join('\n');
}

// --- Pass 3: Test file review ---

function pass3_systemPrompt(testFileCount: number): string {
  const minComments = Math.max(2, Math.min(testFileCount, 5));
  return `You are an expert test reviewer reviewing ONLY test files. Respond with valid JSON only.

{"summary": "1-2 sentence test assessment", "comments": [{"file_path": "path/to/file", "line_hint": "line 30", "comment": "your comment", "type": "suggestion", "severity": "high", "reason": "1-sentence why this matters", "suggested_fix": "+ it('should handle null input', () => {\n+   expect(() => fn(null)).toThrow();\n+ });", "source": "src/utils/helper.ts"}]}

Severity classification (REQUIRED for every comment):
- "critical": missing test for security-critical or crash-prone code path
- "high": missing test for core functionality, error handling, or null cases
- "medium": missing edge-case test, weak assertions, incomplete mocks
- "low": minor test quality issue, test naming, test organization

Context & evidence (REQUIRED):
- "reason" (REQUIRED): One sentence explaining what risk the missing or weak test leaves exposed.
- "suggested_fix" (optional): Include for missing test scaffolding — show the test case skeleton. Use "+" prefix for added lines. Max 6 lines.
- "source" (optional): Cite the implementation file that needs test coverage, e.g. "src/utils/helper.ts".

Rules:
- Focus on: missing test coverage for implementation code, edge cases not tested, assertion quality, mock correctness
- Do NOT comment on individual test cases being "unnecessary" or "redundant"
- Identify MISSING scenarios: what error paths, boundary conditions, or edge cases SHOULD be tested but aren't?
- NEVER write vague comments. Name the SPECIFIC scenario missing, e.g. "No test for when X is null/empty"
- These phrases are BANNED: "consider adding", "could be improved", "ensure". State the missing test case directly
- ONLY use file_path values from the provided test file list. Do NOT invent file paths
- Do NOT comment on .utam.json or .stories.js files — only review actual test files (.test.js, .test.ts)
- Maximum 3 comments per test file
- You MUST return at least ${minComments} comments across different test files
- Cross-reference implementation files to find untested branches and error handling`;
}

function pass3_userPrompt(
  prTitle: string, testDiff: string, testFiles: string[], implFiles: string[],
): string {
  const parts: string[] = [];
  parts.push(`Review test files for PR: "${prTitle}"`);
  parts.push(`\nTest files: ${testFiles.join(', ')}`);
  parts.push(`\nImplementation files being tested: ${implFiles.join(', ')}`);
  parts.push(`\nTest diff:\n${testDiff.substring(0, 28000)}`);
  parts.push(JSON_SCHEMA);
  return parts.join('\n');
}

// --- LLM call helper ---

async function runReviewPass(
  passName: string, systemPrompt: string, userPrompt: string,
): Promise<any> {
  try {
    log(`  [${passName}] Running...`);
    const raw = await claudeChat(systemPrompt, userPrompt, {
      temperature: 0.3,
      maxTokens: 6144,
      jsonMode: true,
    });
    const parsed = parseReviewResponse(raw);
    const result = deduplicateComments(parsed);
    log(`  [${passName}] ${result.comments?.length || 0} comments`);
    return result;
  } catch (error: any) {
    logError(`  [${passName}] Failed: ${error.message}`);
    return { comments: [], summary: `${passName} failed: ${error.message}` };
  }
}

function parseReviewResponse(content: string): any {
  try {
    return JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[1].trim()); } catch { /* fall through */ }
    }
    const braceMatch = content.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try { return JSON.parse(braceMatch[0]); } catch { /* fall through */ }
    }
    return {
      comments: [{ file_path: null, line_hint: null, comment: content.substring(0, 2000), type: 'comment' }],
      summary: 'AI review generated',
    };
  }
}

// Banned patterns — LLM outputs these despite prompt rules; filter programmatically
const LOW_QUALITY_PATTERNS = [
  /not properly scoped/i,
  /not properly handling/i,
  /could be improved/i,
  /\bcss\b.*\bscop/i,          // "CSS ... scoping/scoped"
  /\bwhen X is\b/i,            // Literal prompt example copied
];

const VAGUE_PHRASE_PATTERNS = [
  /^consider (using|adding|fetching|implementing)/i,
  /^add (a simple |proper )?validation/i,
  /^ensure (this|that|the)/i,
];

/**
 * Filter out low-quality comments that match known bad patterns.
 * Returns the comment text cleaned of leading vague phrases, or null if the entire comment is bad.
 */
function filterLowQualityComment(comment: string): string | null {
  // Reject entirely if matches a hard-ban pattern
  for (const p of LOW_QUALITY_PATTERNS) {
    if (p.test(comment)) return null;
  }

  // Strip leading vague phrases if the rest has substance (>30 chars)
  let result = comment;
  for (const p of VAGUE_PHRASE_PATTERNS) {
    if (p.test(result)) {
      const stripped = result.replace(p, '').trim().replace(/^[.,;:\-\u2013\u2014]\s*/, '');
      if (stripped.length > 30) {
        result = stripped.charAt(0).toUpperCase() + stripped.slice(1);
      } else {
        return null;
      }
    }
  }

  // Remove mid-sentence "Consider [verb]ing ..." trailing sentences
  result = result.replace(/\.\s*Consider \w+ing[^.]*\.?\s*$/i, '.').trim();

  return result.length > 15 ? result : null;
}

/**
 * Compute word-level overlap ratio between two strings (Jaccard similarity on word sets).
 */
function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
  return intersection / Math.min(wordsA.size, wordsB.size);
}

/**
 * Post-process review: filter low quality, cap to 3 per file, deduplicate.
 */
function deduplicateComments(review: any): any {
  if (!review?.comments || !Array.isArray(review.comments)) return review;

  // Phase 0: filter low-quality comments + normalize severity
  const VALID_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
  const quality: any[] = [];
  for (const c of review.comments) {
    const cleaned = filterLowQualityComment(c.comment || '');
    if (cleaned !== null) {
      const severity = VALID_SEVERITIES.has(c.severity) ? c.severity : 'medium';
      const reason = c.reason || cleaned.split(/[.!?]/)[0].trim() || '';
      quality.push({ ...c, comment: cleaned, severity, reason });
    }
  }

  // Phase 1: per-file dedup + cap at 3
  const byFile: Record<string, any[]> = {};
  for (const c of quality) {
    const key = c.file_path || '__unknown__';
    if (!byFile[key]) byFile[key] = [];
    byFile[key].push(c);
  }

  const perFileDeduped: any[] = [];
  for (const [, fileComments] of Object.entries(byFile)) {
    const kept: any[] = [];
    for (const c of fileComments) {
      const commentText = (c.comment || '').toLowerCase();
      const isDuplicate = kept.some(k => {
        const kText = (k.comment || '').toLowerCase();
        return commentText.length > 40 && kText.length > 40 &&
          commentText.substring(0, 40) === kText.substring(0, 40);
      });
      if (!isDuplicate) kept.push(c);
    }
    perFileDeduped.push(...kept.slice(0, 3));
  }

  // Phase 2: cross-file dedup using word overlap (Jaccard > 0.6 = duplicate pattern)
  const dedupedComments: any[] = [];
  for (const c of perFileDeduped) {
    const isCrossFileDup = dedupedComments.some(k => wordOverlap(c.comment || '', k.comment || '') > 0.6);
    if (!isCrossFileDup) dedupedComments.push(c);
  }

  return { ...review, comments: dedupedComments };
}

// ---------------------------------------------------------------------------
// Slack message formatter (mirrors formatSlackAnalysis in src/index.ts)
// ---------------------------------------------------------------------------

const SLACK_SECTION_LIMIT = 2900; // Slack section text limit is 3000; leave margin

function pushChunkedSections(blocks: any[], header: string, lines: string[]): void {
  let current = header;
  for (let line of lines) {
    // Truncate any single line that exceeds the limit on its own
    if (line.length > SLACK_SECTION_LIMIT - 10) {
      line = line.substring(0, SLACK_SECTION_LIMIT - 13) + '...';
    }
    if (current.length + 1 + line.length > SLACK_SECTION_LIMIT) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: current } });
      current = line;
    } else {
      current += '\n' + line;
    }
  }
  if (current) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: current } });
  }
}

function formatSlackMessage(review: any, reviewers: any[], noMention = false, prUrl?: string): { text: string; blocks: any[] } {
  const blocks: any[] = [];

  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: ':robot_face: *AI Review Intelligence*' },
  });

  const SEVERITY_CONFIG: { key: string; emoji: string; label: string }[] = [
    { key: 'critical', emoji: ':red_circle:', label: 'Critical' },
    { key: 'high', emoji: ':large_orange_circle:', label: 'High' },
    { key: 'medium', emoji: ':large_yellow_circle:', label: 'Medium' },
    { key: 'low', emoji: ':large_blue_circle:', label: 'Low' },
  ];

  const comments = review?.comments || [];
  if (comments.length > 0) {
    const bySeverity: Record<string, any[]> = { critical: [], high: [], medium: [], low: [] };
    for (const c of comments) {
      const sev = bySeverity[c.severity] ? c.severity : 'medium';
      bySeverity[sev].push(c);
    }

    // Estimate overhead blocks (header, summary, reviewers, dividers, overall feedback)
    const OVERHEAD_BLOCKS = 14;
    const MAX_BLOCKS = 50;
    const activeSeverities = SEVERITY_CONFIG.filter(s => bySeverity[s.key].length > 0).length;
    const perCommentBudget = MAX_BLOCKS - OVERHEAD_BLOCKS - activeSeverities;
    const usePerCommentFeedback = prUrl && (comments.length * 2 <= perCommentBudget);

    // Build a global comment index so feedback buttons reference the original position
    let globalIdx = 0;
    const commentIndexMap = new Map<any, number>();
    for (const { key } of SEVERITY_CONFIG) {
      for (const c of bySeverity[key]) {
        commentIndexMap.set(c, globalIdx++);
      }
    }

    for (const { key, emoji, label } of SEVERITY_CONFIG) {
      if (bySeverity[key].length === 0) continue;

      // Severity header
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `${emoji} *${label}*` }] });

      if (usePerCommentFeedback) {
        // Per-comment: one section + one actions block per comment
        for (const c of bySeverity[key]) {
          const prefix = c.file_path ? `\`${c.file_path}\`` : '';
          const hint = c.line_hint ? ` (${c.line_hint})` : '';
          const tag = c.type ? ` [${c.type}]` : '';
          let text = `${prefix}${hint}${tag} ${c.comment}`;
          if (c.reason) text += `\n_${c.reason}_`;
          if (c.suggested_fix) {
            const fix = c.suggested_fix.length > 400 ? c.suggested_fix.substring(0, 397) + '...' : c.suggested_fix;
            text += `\n\`\`\`\n${fix}\n\`\`\``;
          }
          if (c.source) text += `\n:paperclip: ${c.source}`;
          if (text.length > SLACK_SECTION_LIMIT) text = text.substring(0, SLACK_SECTION_LIMIT - 3) + '...';

          blocks.push({ type: 'section', text: { type: 'mrkdwn', text } });

          const idx = commentIndexMap.get(c) ?? 0;
          const val = JSON.stringify({ pr_url: prUrl, idx });
          blocks.push({
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: ':thumbsup:', emoji: true },
                action_id: 'comment_helpful',
                value: val,
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: ':thumbsdown:', emoji: true },
                action_id: 'comment_not_helpful',
                value: val,
              },
            ],
          });
        }
      } else {
        // Fallback: grouped format (no per-comment buttons)
        const lines: string[] = [];
        for (const c of bySeverity[key]) {
          const prefix = c.file_path ? `\`${c.file_path}\`` : '';
          const hint = c.line_hint ? ` (${c.line_hint})` : '';
          const tag = c.type ? ` [${c.type}]` : '';
          let line = `• ${prefix}${hint}${tag} ${c.comment}`;
          if (c.reason) line += `\n  _${c.reason}_`;
          if (c.suggested_fix) {
            const fix = c.suggested_fix.length > 400 ? c.suggested_fix.substring(0, 397) + '...' : c.suggested_fix;
            line += `\n\`\`\`\n${fix}\n\`\`\``;
          }
          if (c.source) line += `\n  :paperclip: ${c.source}`;
          lines.push(line);
        }
        pushChunkedSections(blocks, '', lines);
      }
    }
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No specific review comments generated._' } });
  }

  if (review?.summary) {
    const summaryText = `*Summary:* ${review.summary}`.substring(0, SLACK_SECTION_LIMIT);
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: summaryText }] });
  }

  blocks.push({ type: 'divider' });

  if (reviewers && reviewers.length > 0) {
    if (noMention) {
      const nameList = reviewers.map((r: any) => `\`${r.ghe_login}\``).join(', ');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:eyes: *Suggested reviewers:* ${nameList}` } });
    } else {
      const mentionList = reviewers.map((r: any) =>
        r.slack_user_id ? `<@${r.slack_user_id}>` : `\`${r.ghe_login}\``
      );
      const mentionStr = mentionList.length === 1
        ? mentionList[0]
        : mentionList.slice(0, -1).join(', ') + ' and ' + mentionList[mentionList.length - 1];
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:eyes: Hey ${mentionStr}, could you take a look at this PR?` } });
    }

    const reasonLines = reviewers.map((r: any) => {
      const name = noMention ? `\`${r.ghe_login}\`` : (r.slack_user_id ? `<@${r.slack_user_id}>` : `\`${r.ghe_login}\``);
      return `• ${name} — ${r.reason}`;
    }).join('\n');

    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: reasonLines }] });
  } else {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No reviewer suggestions available yet._' } });
  }

  // Feedback solicitation
  blocks.push({ type: 'divider' });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ':speech_balloon: Was this review helpful? Your feedback helps improve future suggestions.' }] });
  blocks.push({
    type: 'actions',
    elements: [
      { type: 'button', text: { type: 'plain_text', text: ':thumbsup: Helpful', emoji: true }, action_id: 'ai_review_helpful', value: 'pr_url', style: 'primary' },
      { type: 'button', text: { type: 'plain_text', text: ':thumbsdown: Not Helpful', emoji: true }, action_id: 'ai_review_not_helpful', value: 'pr_url' },
    ],
  });

  const text = `:robot_face: AI Review Intelligence — ${comments.length} comment(s), ${reviewers?.length || 0} reviewer suggestion(s)`;
  return { text, blocks };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const prUrl = process.argv.find(a => a.startsWith('https://'));
  if (!prUrl) {
    console.log('Usage: npm run test-review -- https://git.soma.salesforce.com/org/repo/pull/123');
    process.exit(1);
  }

  if (!HEROKU_API_URL || !WORKER_API_KEY) {
    logError('HEROKU_API_URL and WORKER_API_KEY are required');
    process.exit(1);
  }

  const hostname = extractHostname(prUrl);
  if (!hostname) {
    logError(`Cannot extract hostname from ${prUrl}`);
    process.exit(1);
  }

  const urlMatch = prUrl.match(/\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (!urlMatch) {
    logError(`Cannot parse PR URL: ${prUrl}`);
    process.exit(1);
  }
  const [, org, repo, prNumberStr] = urlMatch;
  const prNumber = parseInt(prNumberStr, 10);

  // Verify Claude AI
  log('Checking Claude AI...');
  try {
    const health = await checkClaudeHealth();
    if (!health.ok) throw new Error(health.error || 'Claude health check failed');
    log(`Claude AI model ready: ${getClaudeModel()}`);
  } catch (error: any) {
    logError(`Claude AI not ready: ${error.message}`);
    logError('Check ANTHROPIC_API_KEY in .env');
    process.exit(1);
  }

  // 1. Fetch PR info
  separator('1. PR DETAILS');
  log('Fetching PR details...');
  const prDetails = await fetchPRDetails(hostname, org, repo, prNumber);
  const prTitle = prDetails.title || `PR #${prNumber}`;
  const prAuthor = prDetails.user?.login || '';
  const prState = prDetails.state;
  const prMerged = prDetails.merged;

  console.log(`  Title:    ${prTitle}`);
  console.log(`  Author:   ${prAuthor}`);
  console.log(`  State:    ${prState}${prMerged ? ' (merged)' : ''}`);
  console.log(`  URL:      ${prUrl}`);

  log('Fetching changed files...');
  const prFiles = await fetchPRFiles(hostname, org, repo, prNumber);
  const changedFiles = prFiles.map((f: any) => f.filename);
  console.log(`  Files:    ${changedFiles.length} changed`);
  for (const f of changedFiles) {
    const file = prFiles.find((pf: any) => pf.filename === f);
    console.log(`            ${f}  (+${file?.additions || 0} -${file?.deletions || 0})`);
  }

  log('Fetching PR diff...');
  const prDiff = await fetchPRDiff(hostname, org, repo, prNumber);
  console.log(`  Diff size: ${prDiff.length} chars`);

  // 2. Fetch learning context and ontology rules
  separator('2. LEARNING CONTEXT');
  const learningContext = await fetchLearningContext();
  console.log(`  ${learningContext.lessons.length} relevant lesson(s), ${learningContext.feedback.length} feedback item(s)`);
  for (const l of learningContext.lessons) {
    const lj = typeof l.lessons_json === 'string' ? JSON.parse(l.lessons_json) : l.lessons_json;
    for (const t of (lj.key_takeaways || [])) console.log(`  - Takeaway: ${t}`);
    if (lj.key_takeaway && !lj.key_takeaways) console.log(`  - Takeaway: ${lj.key_takeaway}`);
  }
  for (const f of learningContext.feedback) {
    console.log(`  - ${f.rating}: "${(f.feedback_text || '').substring(0, 100)}"`);
  }
  if (learningContext.lessons.length === 0 && learningContext.feedback.length === 0) {
    console.log('  No learning context yet — will improve as PRs are reviewed and closed.');
  }

  // 3. Fetch full file content for context-aware doc matching
  separator('3. FILE CONTEXT FOR DOC MATCHING');
  const headSha = prDetails.head?.sha || '';
  const implPrFiles = prFiles
    .filter((f: any) => !TEST_FILE_PATTERN.test(f.filename) && !SKIP_FILE_PATTERN.test(f.filename))
    .sort((a: any, b: any) => (b.additions || 0) - (a.additions || 0))
    .slice(0, 8);

  const fileContents: { path: string; content: string }[] = [];
  for (const f of implPrFiles) {
    const content = await fetchFileContent(hostname, org, repo, f.filename, headSha);
    if (content) {
      fileContents.push({ path: f.filename, content });
      console.log(`  Fetched: ${f.filename} (${content.length} chars)`);
    } else {
      console.log(`  Failed:  ${f.filename}`);
    }
  }
  console.log(`  Fetched ${fileContents.length}/${implPrFiles.length} file(s)\n`);

  // 4. Ontology-based rule resolution
  separator('4. ONTOLOGY RULE RESOLUTION');
  log('Resolving coding rules via ontology engine...');
  const ontologyResult = await fetchOntologyRules(changedFiles, prDiff);
  console.log(`  Deterministic rules: ${ontologyResult.rules.length}`);
  console.log(`  Unmatched files: ${ontologyResult.unmatched_files.length}`);
  for (const rule of ontologyResult.rules) {
    console.log(`    [${rule.severity}] ${rule.title} (${rule.rule_key}) — matched via: ${rule.matched_via}`);
  }

  // LLM classifier fallback for unmatched files
  let llmClassifiedDomainIds: number[] = [];
  if (ontologyResult.unmatched_files.length > 0 && ontologyResult.taxonomy.length > 0) {
    log('Running LLM classifier for unmatched files...');
    llmClassifiedDomainIds = await classifyUnmatchedFilesViaLLM(
      ontologyResult.unmatched_files, prDiff, ontologyResult.taxonomy,
    );
    console.log(`  LLM classified into ${llmClassifiedDomainIds.length} domain(s)`);
  }

  const allRules = [...ontologyResult.rules];
  console.log(`\n  Total applicable rules: ${allRules.length}`);

  // 5. Multi-pass LLM review
  separator('5. AI REVIEW — MULTI-PASS (via Claude)');
  log(`Generating review with ${getClaudeModel()} (3-pass)...`);

  // Split diff into implementation and test files
  const { implDiff, testDiff, implFiles, testFiles } = splitDiff(prDiff);
  console.log(`  Split: ${implFiles.length} implementation file(s), ${testFiles.length} test file(s)`);
  console.log(`  Impl diff: ${implDiff.length} chars (sending first 24000)`);
  console.log(`  Test diff: ${testDiff.length} chars (sending first 24000)\n`);

  let allComments: any[] = [];
  const summaries: string[] = [];

  // --- Pass 1: Implementation code review ---
  separator('5a. PASS 1 — Implementation Review');
  if (implFiles.length > 0) {
    const p1 = await runReviewPass(
      'Pass 1: Implementation',
      pass1_systemPrompt(implFiles.length),
      pass1_userPrompt(prTitle, implDiff, implFiles, learningContext),
    );
    allComments.push(...(p1.comments || []));
    if (p1.summary) summaries.push(p1.summary);
    for (const c of (p1.comments || [])) {
      console.log(`    [${c.severity || 'medium'}|${c.type}] ${c.file_path}: ${c.comment.substring(0, 120)}...`);
    }
  } else {
    console.log('  No implementation files to review.');
  }

  // --- Pass 2: Ontology rules compliance ---
  separator('5b. PASS 2 — Rules Compliance');
  if (implFiles.length > 0 && allRules.length > 0) {
    const p2 = await runReviewPass(
      'Pass 2: Rules Compliance',
      pass2_systemPrompt(),
      pass2_userPrompt(prTitle, implDiff, implFiles, allRules),
    );
    allComments.push(...(p2.comments || []));
    if (p2.summary && p2.summary !== 'No rule violations found') summaries.push(p2.summary);
    for (const c of (p2.comments || [])) {
      console.log(`    [${c.severity || 'medium'}|${c.type}] ${c.file_path}: ${c.comment.substring(0, 120)}...`);
    }
  } else {
    console.log(`  Skipped — ${allRules.length === 0 ? 'no ontology rules matched for this PR' : 'no implementation files'}`);
  }

  // --- Pass 3: Test file review ---
  separator('5c. PASS 3 — Test Review');
  if (testFiles.length > 0) {
    const p3 = await runReviewPass(
      'Pass 3: Tests',
      pass3_systemPrompt(testFiles.length),
      pass3_userPrompt(prTitle, testDiff, testFiles, implFiles),
    );
    allComments.push(...(p3.comments || []));
    if (p3.summary) summaries.push(p3.summary);
    for (const c of (p3.comments || [])) {
      console.log(`    [${c.severity || 'medium'}|${c.type}] ${c.file_path}: ${c.comment.substring(0, 120)}...`);
    }
  } else {
    console.log('  No test files to review.');
  }

  // Filter out comments with hallucinated file paths
  const validPaths = new Set([...implFiles, ...testFiles]);
  const validComments = allComments.filter(c => {
    if (!c.file_path) return true;
    if (validPaths.has(c.file_path)) return true;
    // Fuzzy match: check if any valid path ends with the comment's path
    for (const vp of validPaths) {
      if (vp.endsWith(c.file_path) || c.file_path.endsWith(vp.split('/').slice(-2).join('/'))) return true;
    }
    log(`  Filtered out comment with invalid path: ${c.file_path}`);
    return false;
  });

  // Merge and deduplicate all pass results
  const mergedReview = deduplicateComments({
    summary: summaries.join(' '),
    comments: validComments,
  });

  const review = mergedReview;
  separator('5d. MERGED RESULTS');
  console.log(`  Summary: ${review.summary || 'N/A'}\n`);
  const comments = review.comments || [];
  console.log(`  ${comments.length} review comment(s):\n`);
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    const sevLabel = (c.severity || 'medium').toUpperCase();
    console.log(`  --- Comment ${i + 1} [${sevLabel}] [${c.type || 'comment'}] ---`);
    if (c.file_path) console.log(`  File: ${c.file_path}`);
    if (c.line_hint) console.log(`  Location: ${c.line_hint}`);
    if (c.reason) console.log(`  Reason: ${c.reason}`);
    if (c.suggested_fix) {
      console.log(`  Fix:`);
      for (const fl of c.suggested_fix.split('\n')) console.log(`    ${fl}`);
    }
    if (c.source) console.log(`  Source: ${c.source}`);
    console.log(`  ${c.comment}`);
    console.log('');
  }

  // 6. Suggested reviewers
  separator('6. SUGGESTED REVIEWERS');
  let reviewers: any[] = [];
  try {
    reviewers = await fetchSuggestedReviewers(changedFiles, prAuthor);
    if (reviewers.length === 0) {
      console.log('  No reviewer suggestions (not enough review history yet)');
    } else {
      for (let i = 0; i < reviewers.length; i++) {
        const r = reviewers[i];
        console.log(`  [${i + 1}] ${r.ghe_login}${r.slack_user_id ? ` (Slack: <@${r.slack_user_id}>)` : ''}`);
        console.log(`      Score: ${r.score}  Reason: ${r.reason || 'N/A'}`);
      }
    }
  } catch (error: any) {
    console.log(`  Could not fetch reviewer suggestions: ${error.message}`);
  }

  // 7. Slack message preview
  const noMention = process.argv.includes('--no-mention');
  separator('7. SLACK MESSAGE PREVIEW');
  const slackMessage = formatSlackMessage(review, reviewers, noMention, prUrl);
  if (noMention) log('Reviewer @mentions suppressed (--no-mention)');
  console.log('  Below is what would be posted as a Slack thread reply:\n');
  console.log('  ┌─────────────────────────────────────────────────────────┐');
  for (const block of slackMessage.blocks) {
    if (block.type === 'divider') {
      console.log('  │ ─────────────────────────────────────────────────────── │');
    } else if (block.type === 'section' && block.text?.text) {
      const lines = block.text.text.split('\n');
      for (const line of lines) {
        console.log(`  │ ${line}`);
      }
    } else if (block.type === 'context' && block.elements) {
      for (const el of block.elements) {
        console.log(`  │ ${el.text}`);
      }
    }
  }
  console.log('  └─────────────────────────────────────────────────────────┘');

  // Post to Slack if --post flag is passed
  const shouldPost = process.argv.includes('--post');
  const postChannel = process.argv.find(a => a.startsWith('--channel='))?.split('=')[1];

  if (shouldPost) {
    separator('8. POSTING TO SLACK');
    const slackToken = process.env.SLACK_BOT_TOKEN;
    if (!slackToken) {
      logError('SLACK_BOT_TOKEN is required to post. Skipping Slack post.');
    } else if (!postChannel) {
      logError('Provide --channel=CHANNEL_ID to post. Example: --post --channel=C0123456');
    } else {
      log(`Posting to channel ${postChannel}...`);
      try {
        const postResp = await axios.post('https://slack.com/api/chat.postMessage', {
          channel: postChannel,
          text: slackMessage.text,
          blocks: slackMessage.blocks,
        }, {
          headers: {
            Authorization: `Bearer ${slackToken}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        });
        if (postResp.data.ok) {
          log(`✅ Posted to Slack! ts=${postResp.data.ts}`);
        } else {
          logError(`Slack API error: ${postResp.data.error}`);
        }
      } catch (error: any) {
        logError(`Failed to post to Slack: ${error.message}`);
      }
    }
  }

  separator('DONE');
  if (!shouldPost) {
    console.log('  This was a dry run — nothing was saved or posted to Slack.');
    console.log('  To post to Slack, re-run with: --post --channel=CHANNEL_ID\n');
  }
}

run().then(() => process.exit(0)).catch((error) => {
  logError(`Fatal error: ${error}`);
  process.exit(1);
});
