"use strict";
/**
 * Ontology Engine
 *
 * Deterministic rule resolver that maps changed files and code patterns
 * to exact coding rules via the ontology graph (code_domains, code_rules,
 * rule_matchers, domain_file_mappings).
 *
 * Replaces fuzzy vector-similarity retrieval for rule lookup.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getAllDomains = getAllDomains;
exports.getDomainWithAncestors = getDomainWithAncestors;
exports.getDomainWithDescendants = getDomainWithDescendants;
exports.matchFilePathsToDomains = matchFilePathsToDomains;
exports.getRulesForDomains = getRulesForDomains;
exports.matchCodePatterns = matchCodePatterns;
exports.matchFilePathsToRules = matchFilePathsToRules;
exports.getRulesByIds = getRulesByIds;
exports.resolveRulesForPR = resolveRulesForPR;
exports.createDomain = createDomain;
exports.createRule = createRule;
exports.createRuleMatcher = createRuleMatcher;
exports.createDomainFileMapping = createDomainFileMapping;
exports.updateRule = updateRule;
exports.deleteRule = deleteRule;
exports.listRules = listRules;
exports.getDomainTaxonomy = getDomainTaxonomy;
const client_1 = require("../db/client");
const minimatch_1 = require("minimatch");
// ---------------------------------------------------------------------------
// Domain queries
// ---------------------------------------------------------------------------
/**
 * Get all domains as a flat list.
 */
async function getAllDomains() {
    const result = await client_1.pool.query('SELECT * FROM code_domains ORDER BY name');
    return result.rows;
}
/**
 * Get a domain and all its ancestors (recursive CTE walk up the tree).
 */
async function getDomainWithAncestors(domainId) {
    const result = await client_1.pool.query(`
    WITH RECURSIVE ancestors AS (
      SELECT * FROM code_domains WHERE id = $1
      UNION ALL
      SELECT cd.* FROM code_domains cd
      JOIN ancestors a ON cd.id = a.parent_id
    )
    SELECT * FROM ancestors
  `, [domainId]);
    return result.rows;
}
/**
 * Get a domain and all its descendants (recursive CTE walk down the tree).
 */
async function getDomainWithDescendants(domainId) {
    const result = await client_1.pool.query(`
    WITH RECURSIVE descendants AS (
      SELECT * FROM code_domains WHERE id = $1
      UNION ALL
      SELECT cd.* FROM code_domains cd
      JOIN descendants d ON cd.parent_id = d.id
    )
    SELECT * FROM descendants
  `, [domainId]);
    return result.rows;
}
// ---------------------------------------------------------------------------
// Step 1: File-path → domains → rules
// ---------------------------------------------------------------------------
/**
 * Match changed file paths against domain_file_mappings to find applicable domains.
 * Uses glob matching (via minimatch) for flexibility.
 */
async function matchFilePathsToDomains(changedFiles) {
    const result = await client_1.pool.query('SELECT * FROM domain_file_mappings ORDER BY priority DESC');
    const mappings = result.rows;
    const matches = [];
    for (const file of changedFiles) {
        for (const mapping of mappings) {
            if ((0, minimatch_1.minimatch)(file, mapping.file_pattern, { dot: true, nocase: true })) {
                matches.push({
                    domainId: mapping.domain_id,
                    filePath: file,
                    pattern: mapping.file_pattern,
                });
            }
        }
    }
    return matches;
}
/**
 * Get all enabled rules for a set of domain IDs, including rules inherited
 * from ancestor domains (walk up the tree).
 */
async function getRulesForDomains(domainIds) {
    if (domainIds.length === 0)
        return [];
    // Use recursive CTE to get all ancestor domain IDs too
    const result = await client_1.pool.query(`
    WITH RECURSIVE domain_tree AS (
      SELECT id, name, display_name, parent_id FROM code_domains WHERE id = ANY($1)
      UNION ALL
      SELECT cd.id, cd.name, cd.display_name, cd.parent_id
      FROM code_domains cd
      JOIN domain_tree dt ON cd.id = dt.parent_id
    )
    SELECT DISTINCT cr.*, dt.name AS domain_name, dt.display_name AS domain_display_name
    FROM code_rules cr
    JOIN domain_tree dt ON cr.domain_id = dt.id
    WHERE cr.enabled = TRUE
    ORDER BY cr.severity ASC, cr.rule_key
  `, [domainIds]);
    return result.rows;
}
// ---------------------------------------------------------------------------
// Step 2: Code patterns → rules
// ---------------------------------------------------------------------------
/**
 * Scan diff text against rule_matchers to find directly triggered rules.
 * Supports both regex and glob patterns.
 */
async function matchCodePatterns(diffText) {
    const result = await client_1.pool.query(`
    SELECT rm.*, cr.enabled
    FROM rule_matchers rm
    JOIN code_rules cr ON rm.rule_id = cr.id
    WHERE cr.enabled = TRUE
    ORDER BY rm.priority DESC
  `);
    const matchers = result.rows;
    const matches = [];
    const matchedRuleIds = new Set();
    for (const matcher of matchers) {
        if (matchedRuleIds.has(matcher.rule_id))
            continue; // one match per rule is enough
        let matched = false;
        if (matcher.matcher_type === 'code_pattern') {
            if (matcher.is_regex) {
                try {
                    const regex = new RegExp(matcher.pattern, 'im');
                    matched = regex.test(diffText);
                }
                catch {
                    // Invalid regex — skip
                }
            }
            else {
                // Plain text search (case-insensitive)
                matched = diffText.toLowerCase().includes(matcher.pattern.toLowerCase());
            }
        }
        else if (matcher.matcher_type === 'annotation') {
            // Look for annotation patterns like @Entity, @Configuration
            const escaped = matcher.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\b${escaped}\\b`, 'i');
            matched = regex.test(diffText);
        }
        // file_glob and file_extension matchers are handled via matchFilePathsToRules below
        if (matched) {
            matchedRuleIds.add(matcher.rule_id);
            matches.push({
                ruleId: matcher.rule_id,
                matcherType: matcher.matcher_type,
                pattern: matcher.pattern,
            });
        }
    }
    return matches;
}
/**
 * Match changed file paths directly against rule_matchers of type 'file_glob',
 * 'file_extension', and 'directory'.
 */
async function matchFilePathsToRules(changedFiles) {
    const result = await client_1.pool.query(`
    SELECT rm.*
    FROM rule_matchers rm
    JOIN code_rules cr ON rm.rule_id = cr.id
    WHERE cr.enabled = TRUE
      AND rm.matcher_type IN ('file_glob', 'file_extension', 'directory')
    ORDER BY rm.priority DESC
  `);
    const matchers = result.rows;
    const matches = [];
    const matchedPairs = new Set(); // ruleId:filePath
    for (const file of changedFiles) {
        for (const matcher of matchers) {
            const key = `${matcher.rule_id}:${file}`;
            if (matchedPairs.has(key))
                continue;
            let matched = false;
            switch (matcher.matcher_type) {
                case 'file_glob':
                    matched = (0, minimatch_1.minimatch)(file, matcher.pattern, { dot: true, nocase: true });
                    break;
                case 'file_extension': {
                    const ext = file.split('.').pop()?.toLowerCase() || '';
                    matched = ext === matcher.pattern.toLowerCase().replace(/^\./, '');
                    break;
                }
                case 'directory':
                    matched = file.startsWith(matcher.pattern) ||
                        (0, minimatch_1.minimatch)(file, matcher.pattern + '/**', { dot: true, nocase: true });
                    break;
            }
            if (matched) {
                matchedPairs.add(key);
                matches.push({
                    ruleId: matcher.rule_id,
                    matcherType: matcher.matcher_type,
                    pattern: matcher.pattern,
                    filePath: file,
                });
            }
        }
    }
    return matches;
}
/**
 * Fetch full rule objects by their IDs.
 */
async function getRulesByIds(ruleIds) {
    if (ruleIds.length === 0)
        return [];
    const result = await client_1.pool.query(`
    SELECT cr.*, cd.name AS domain_name, cd.display_name AS domain_display_name
    FROM code_rules cr
    JOIN code_domains cd ON cr.domain_id = cd.id
    WHERE cr.id = ANY($1) AND cr.enabled = TRUE
    ORDER BY cr.severity ASC, cr.rule_key
  `, [ruleIds]);
    return result.rows;
}
// ---------------------------------------------------------------------------
// Main resolver: combines all matching strategies
// ---------------------------------------------------------------------------
/**
 * Resolve all applicable rules for a PR given its changed files and diff text.
 * This is the main entry point — deterministic, no vector search.
 *
 * Returns a deduplicated, severity-sorted list of rules with match metadata.
 */
async function resolveRulesForPR(changedFiles, diffText) {
    const resolvedMap = new Map();
    // Step 1: File paths → domains → rules (with inheritance)
    const domainMatches = await matchFilePathsToDomains(changedFiles);
    const domainIds = [...new Set(domainMatches.map(m => m.domainId))];
    const domainRules = await getRulesForDomains(domainIds);
    for (const rule of domainRules) {
        if (!resolvedMap.has(rule.id)) {
            const matchingFile = domainMatches.find(m => {
                // Find which file triggered this domain
                return true; // all domain matches contributed
            });
            resolvedMap.set(rule.id, {
                ...rule,
                matched_via: 'file_path',
                match_detail: domainMatches
                    .filter(m => m.domainId === rule.domain_id)
                    .map(m => `${m.filePath} matched ${m.pattern}`)
                    .join('; ') || 'domain inheritance',
                domain_name: rule.domain_name,
                domain_display_name: rule.domain_display_name,
            });
        }
    }
    // Step 2: File paths → direct rule matchers (file_glob, file_extension, directory)
    const fileRuleMatches = await matchFilePathsToRules(changedFiles);
    const fileRuleIds = [...new Set(fileRuleMatches.map(m => m.ruleId))];
    const fileRules = await getRulesByIds(fileRuleIds);
    for (const rule of fileRules) {
        if (!resolvedMap.has(rule.id)) {
            const matchDetails = fileRuleMatches
                .filter(m => m.ruleId === rule.id)
                .map(m => `${m.filePath} matched ${m.matcherType}:${m.pattern}`);
            resolvedMap.set(rule.id, {
                ...rule,
                matched_via: 'file_path',
                match_detail: matchDetails.join('; '),
                domain_name: rule.domain_name,
                domain_display_name: rule.domain_display_name,
            });
        }
    }
    // Step 3: Code patterns in diff → direct rule matchers
    const codePatternMatches = await matchCodePatterns(diffText);
    const codeRuleIds = [...new Set(codePatternMatches.map(m => m.ruleId))];
    const codeRules = await getRulesByIds(codeRuleIds);
    for (const rule of codeRules) {
        if (!resolvedMap.has(rule.id)) {
            const matchDetails = codePatternMatches
                .filter(m => m.ruleId === rule.id)
                .map(m => `diff matched ${m.matcherType}:${m.pattern}`);
            resolvedMap.set(rule.id, {
                ...rule,
                matched_via: 'code_pattern',
                match_detail: matchDetails.join('; '),
                domain_name: rule.domain_name,
                domain_display_name: rule.domain_display_name,
            });
        }
    }
    // Sort by severity priority: critical > high > medium > low
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const rules = Array.from(resolvedMap.values());
    rules.sort((a, b) => (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99));
    return rules;
}
// ---------------------------------------------------------------------------
// CRUD helpers for rules management
// ---------------------------------------------------------------------------
async function createDomain(name, displayName, parentId, description) {
    const result = await client_1.pool.query(`
    INSERT INTO code_domains (name, display_name, parent_id, description)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [name, displayName, parentId, description || null]);
    return result.rows[0];
}
async function createRule(domainId, ruleKey, title, description, severity = 'high', teamOwner) {
    const result = await client_1.pool.query(`
    INSERT INTO code_rules (domain_id, rule_key, title, description, severity, team_owner)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [domainId, ruleKey, title, description, severity, teamOwner || null]);
    return result.rows[0];
}
async function createRuleMatcher(ruleId, matcherType, pattern, isRegex = false, priority = 0) {
    const result = await client_1.pool.query(`
    INSERT INTO rule_matchers (rule_id, matcher_type, pattern, is_regex, priority)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [ruleId, matcherType, pattern, isRegex, priority]);
    return result.rows[0];
}
async function createDomainFileMapping(domainId, filePattern, priority = 0) {
    await client_1.pool.query(`
    INSERT INTO domain_file_mappings (domain_id, file_pattern, priority)
    VALUES ($1, $2, $3)
  `, [domainId, filePattern, priority]);
}
async function updateRule(ruleId, updates) {
    const fields = [];
    const values = [];
    let paramIdx = 1;
    if (updates.title !== undefined) {
        fields.push(`title = $${paramIdx++}`);
        values.push(updates.title);
    }
    if (updates.description !== undefined) {
        fields.push(`description = $${paramIdx++}`);
        values.push(updates.description);
    }
    if (updates.severity !== undefined) {
        fields.push(`severity = $${paramIdx++}`);
        values.push(updates.severity);
    }
    if (updates.enabled !== undefined) {
        fields.push(`enabled = $${paramIdx++}`);
        values.push(updates.enabled);
    }
    if (updates.team_owner !== undefined) {
        fields.push(`team_owner = $${paramIdx++}`);
        values.push(updates.team_owner);
    }
    if (fields.length === 0)
        return null;
    fields.push(`updated_at = NOW()`);
    values.push(ruleId);
    const result = await client_1.pool.query(`UPDATE code_rules SET ${fields.join(', ')} WHERE id = $${paramIdx} RETURNING *`, values);
    return result.rows[0] || null;
}
async function deleteRule(ruleId) {
    const result = await client_1.pool.query('DELETE FROM code_rules WHERE id = $1', [ruleId]);
    return (result.rowCount || 0) > 0;
}
async function listRules(options) {
    const conditions = [];
    const values = [];
    let paramIdx = 1;
    if (options?.domainId !== undefined) {
        conditions.push(`cr.domain_id = $${paramIdx++}`);
        values.push(options.domainId);
    }
    if (options?.teamOwner) {
        conditions.push(`cr.team_owner = $${paramIdx++}`);
        values.push(options.teamOwner);
    }
    if (options?.enabledOnly) {
        conditions.push('cr.enabled = TRUE');
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await client_1.pool.query(`
    SELECT cr.*, cd.name AS domain_name, cd.display_name AS domain_display_name,
           (SELECT COUNT(*) FROM rule_matchers rm WHERE rm.rule_id = cr.id) AS matcher_count
    FROM code_rules cr
    JOIN code_domains cd ON cr.domain_id = cd.id
    ${where}
    ORDER BY cd.name, cr.severity, cr.rule_key
  `, values);
    return result.rows;
}
/**
 * Get the full domain taxonomy with rule counts — used as context for the
 * LLM classifier when deterministic matching finds nothing.
 */
async function getDomainTaxonomy() {
    const result = await client_1.pool.query(`
    WITH RECURSIVE tree AS (
      SELECT id, name, display_name, description, parent_id, 0 AS depth
      FROM code_domains WHERE parent_id IS NULL
      UNION ALL
      SELECT cd.id, cd.name, cd.display_name, cd.description, cd.parent_id, t.depth + 1
      FROM code_domains cd
      JOIN tree t ON cd.parent_id = t.id
    )
    SELECT t.id, t.name, t.display_name, t.description, t.depth,
           (SELECT COUNT(*) FROM code_rules cr WHERE cr.domain_id = t.id AND cr.enabled = TRUE) AS rule_count
    FROM tree t
    ORDER BY t.name
  `);
    return result.rows;
}
//# sourceMappingURL=ontologyEngine.js.map