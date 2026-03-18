"use strict";
/**
 * Rule Classifier (LLM Fallback)
 *
 * When the deterministic ontology engine finds zero rules for a file,
 * this classifier uses the existing Ollama LLM to classify the code diff
 * into domain categories, then fetches exact rules for those domains.
 *
 * This is structured classification with a fixed taxonomy — NOT vector similarity.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyDiffIntoDomains = classifyDiffIntoDomains;
exports.classifyAndResolveRules = classifyAndResolveRules;
exports.classifyUnmatchedFiles = classifyUnmatchedFiles;
const ollama_1 = require("ollama");
const ontologyEngine_1 = require("./ontologyEngine");
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:14b';
let ollamaClient = null;
function getClient() {
    if (!ollamaClient) {
        ollamaClient = new ollama_1.Ollama({ host: OLLAMA_HOST });
    }
    return ollamaClient;
}
// ---------------------------------------------------------------------------
// Taxonomy formatting
// ---------------------------------------------------------------------------
function formatTaxonomyForPrompt(taxonomy) {
    return taxonomy
        .filter(d => d.rule_count > 0) // only show domains that have rules
        .map(d => {
        const indent = '  '.repeat(d.depth);
        const desc = d.description ? ` — ${d.description}` : '';
        return `${indent}${d.id}: ${d.display_name}${desc} (${d.rule_count} rules)`;
    })
        .join('\n');
}
// ---------------------------------------------------------------------------
// LLM Classification
// ---------------------------------------------------------------------------
/**
 * Ask the LLM to classify a code diff into one or more domains from the
 * ontology taxonomy. Returns domain IDs.
 *
 * This is called ONLY when deterministic matching finds no rules for a file.
 */
async function classifyDiffIntoDomains(filePath, diffSnippet, taxonomy) {
    // Load taxonomy if not provided
    const domains = taxonomy || await (0, ontologyEngine_1.getDomainTaxonomy)();
    if (domains.length === 0)
        return [];
    const taxonomyText = formatTaxonomyForPrompt(domains);
    if (!taxonomyText.trim())
        return []; // no domains with rules
    const prompt = `You are a code classifier. Given a code diff, determine which coding rule domains apply.

DOMAINS (id: name — description):
${taxonomyText}

FILE: ${filePath}
DIFF:
${diffSnippet.substring(0, 4000)}

Respond with ONLY a JSON array of domain IDs that apply to this code change.
If no domains apply, respond with [].
Example: [3, 7, 12]`;
    try {
        const client = getClient();
        const response = await client.chat({
            model: OLLAMA_MODEL,
            messages: [{ role: 'user', content: prompt }],
            options: { num_predict: 100, temperature: 0.1 },
            format: 'json',
        });
        const text = response.message?.content?.trim() || '[]';
        // Parse the JSON array from the response
        const parsed = JSON.parse(text);
        // Handle both { "domains": [...] } and plain [...] formats
        const ids = Array.isArray(parsed)
            ? parsed
            : Array.isArray(parsed.domains)
                ? parsed.domains
                : Array.isArray(parsed.domain_ids)
                    ? parsed.domain_ids
                    : [];
        // Validate: only keep IDs that exist in the taxonomy
        const validIds = new Set(domains.map(d => d.id));
        return ids.filter(id => typeof id === 'number' && validIds.has(id));
    }
    catch (error) {
        console.error(`[RuleClassifier] LLM classification failed: ${error.message}`);
        return [];
    }
}
/**
 * Full fallback pipeline: classify a file diff via LLM and return its exact rules.
 */
async function classifyAndResolveRules(filePath, diffSnippet, taxonomy) {
    const domainIds = await classifyDiffIntoDomains(filePath, diffSnippet, taxonomy);
    if (domainIds.length === 0)
        return [];
    const rules = await (0, ontologyEngine_1.getRulesForDomains)(domainIds);
    return rules.map(rule => ({
        ...rule,
        matched_via: 'llm_classifier',
        match_detail: `LLM classified ${filePath} into domain ${rule.domain_name}`,
    }));
}
// ---------------------------------------------------------------------------
// Batch classification for multiple unmatched files
// ---------------------------------------------------------------------------
/**
 * For a set of files that had no deterministic matches, run LLM classification
 * on each and merge the results. Deduplicates rules across files.
 */
async function classifyUnmatchedFiles(unmatchedFiles) {
    if (unmatchedFiles.length === 0)
        return [];
    // Load taxonomy once
    const taxonomy = await (0, ontologyEngine_1.getDomainTaxonomy)();
    if (taxonomy.length === 0)
        return [];
    const resolvedMap = new Map();
    for (const file of unmatchedFiles) {
        const rules = await classifyAndResolveRules(file.filePath, file.diffSnippet, taxonomy);
        for (const rule of rules) {
            if (!resolvedMap.has(rule.id)) {
                resolvedMap.set(rule.id, rule);
            }
        }
    }
    // Sort by severity
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const rules = Array.from(resolvedMap.values());
    rules.sort((a, b) => (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99));
    return rules;
}
//# sourceMappingURL=ruleClassifier.js.map