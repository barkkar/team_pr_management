"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchDomainScopedCodeExamples = fetchDomainScopedCodeExamples;
exports.formatCodeExamplesForPrompt = formatCodeExamplesForPrompt;
const client_1 = require("../db/client");
/**
 * Fetch domain-scoped code examples for PR review context.
 *
 * Algorithm:
 * 1. Query repo_knowledge WHERE domain_id IN (domainIds)
 * 2. Exclude changed files (don't show their own code back)
 * 3. Prefer same org/repo if specified
 * 4. Diversify: different files, different element types
 * 5. Sort by: same repo first, shorter chunks preferred, diverse domains
 */
async function fetchDomainScopedCodeExamples(options) {
    const { domainIds, changedFiles, org, repo, elementTypes, limit = 5, maxPerFile = 1, } = options;
    if (domainIds.length === 0) {
        return [];
    }
    // Build query with filters
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
    const params = [domainIds, changedFiles];
    let paramCount = 2;
    // Add element type filter if specified
    if (elementTypes && elementTypes.length > 0) {
        paramCount++;
        query += ` AND rk.code_element_type = ANY($${paramCount}::text[])`;
        params.push(elementTypes);
    }
    // Add org/repo filter if specified
    if (org && repo) {
        paramCount++;
        const orgParamNum = paramCount;
        paramCount++;
        const repoParamNum = paramCount;
        query += ` AND rk.org = $${orgParamNum} AND rk.repo = $${repoParamNum}`;
        params.push(org, repo);
    }
    // Add sorting and limit
    query += `
    ORDER BY
      ${org && repo ? `CASE WHEN rk.org = $${paramCount - 1} AND rk.repo = $${paramCount} THEN 0 ELSE 1 END,` : ''}
      LENGTH(rk.content_chunk) ASC,
      rk.domain_id,
      rk.updated_at DESC
  `;
    paramCount++;
    query += ` LIMIT $${paramCount}`;
    params.push(limit * 3); // Fetch extra for diversification
    const result = await client_1.pool.query(query, params);
    // Diversify: max N examples per file, spread across domains
    const diversified = diversifyExamples(result.rows, maxPerFile, limit);
    return diversified;
}
function diversifyExamples(examples, maxPerFile, totalLimit) {
    const fileCount = new Map();
    const domainCount = new Map();
    const selected = [];
    for (const ex of examples) {
        if (selected.length >= totalLimit)
            break;
        const fileKey = ex.file_path;
        const currentFileCount = fileCount.get(fileKey) || 0;
        // Skip if we already have enough from this file
        if (currentFileCount >= maxPerFile)
            continue;
        // Prefer spreading across domains (deprioritize if domain is over-represented)
        const currentDomainCount = domainCount.get(ex.domain_id) || 0;
        const avgDomainCount = selected.length / (domainCount.size || 1);
        if (currentDomainCount > avgDomainCount * 1.5 && selected.length > 2) {
            continue; // Skip over-represented domains
        }
        selected.push(ex);
        fileCount.set(fileKey, currentFileCount + 1);
        domainCount.set(ex.domain_id, currentDomainCount + 1);
    }
    return selected;
}
/**
 * Format code examples for inclusion in LLM prompts.
 */
function formatCodeExamplesForPrompt(examples) {
    if (examples.length === 0) {
        return '';
    }
    const parts = ['\nRELATED CODE EXAMPLES from this codebase domain:'];
    for (const ex of examples) {
        const elementInfo = ex.code_element_name
            ? `${ex.code_element_type}: ${ex.code_element_name}`
            : ex.code_element_type || 'code';
        parts.push(`\n--- ${ex.file_path} (${ex.domain_display_name || ex.domain_name}) [${elementInfo}] ---`);
        parts.push(ex.content_chunk.substring(0, 500)); // Cap at 500 chars per example
    }
    parts.push('\nUse these examples to understand existing patterns and conventions in this domain.');
    return parts.join('\n');
}
//# sourceMappingURL=codeContextProvider.js.map