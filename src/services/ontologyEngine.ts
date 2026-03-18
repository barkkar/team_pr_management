/**
 * Ontology Engine
 *
 * Deterministic rule resolver that maps changed files and code patterns
 * to exact coding rules via the ontology graph (code_domains, code_rules,
 * rule_matchers, domain_file_mappings).
 *
 * Replaces fuzzy vector-similarity retrieval for rule lookup.
 */

import { pool } from '../db/client';
import { minimatch } from 'minimatch';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CodeDomain {
  id: number;
  name: string;
  display_name: string;
  parent_id: number | null;
  description: string | null;
  created_at: Date;
}

export interface CodeRule {
  id: number;
  domain_id: number;
  rule_key: string;
  title: string;
  description: string;
  severity: string;
  enabled: boolean;
  team_owner: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface RuleMatcher {
  id: number;
  rule_id: number;
  matcher_type: string;
  pattern: string;
  is_regex: boolean;
  priority: number;
}

export interface ResolvedRule extends CodeRule {
  matched_via: string; // 'file_path' | 'code_pattern' | 'domain_inheritance' | 'llm_classifier'
  match_detail: string; // what pattern/file triggered the match
  domain_name: string;
  domain_display_name: string;
}

// ---------------------------------------------------------------------------
// Domain queries
// ---------------------------------------------------------------------------

/**
 * Get all domains as a flat list.
 */
export async function getAllDomains(): Promise<CodeDomain[]> {
  const result = await pool.query(
    'SELECT * FROM code_domains ORDER BY name',
  );
  return result.rows;
}

/**
 * Get a domain and all its ancestors (recursive CTE walk up the tree).
 */
export async function getDomainWithAncestors(domainId: number): Promise<CodeDomain[]> {
  const result = await pool.query(`
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
export async function getDomainWithDescendants(domainId: number): Promise<CodeDomain[]> {
  const result = await pool.query(`
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
export async function matchFilePathsToDomains(
  changedFiles: string[],
): Promise<{ domainId: number; filePath: string; pattern: string }[]> {
  const result = await pool.query(
    'SELECT * FROM domain_file_mappings ORDER BY priority DESC',
  );
  const mappings: { domain_id: number; file_pattern: string }[] = result.rows;

  const matches: { domainId: number; filePath: string; pattern: string }[] = [];

  for (const file of changedFiles) {
    for (const mapping of mappings) {
      if (minimatch(file, mapping.file_pattern, { dot: true, nocase: true })) {
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
export async function getRulesForDomains(domainIds: number[]): Promise<(CodeRule & { domain_name: string; domain_display_name: string })[]> {
  if (domainIds.length === 0) return [];

  // Use recursive CTE to get all ancestor domain IDs too
  const result = await pool.query(`
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
export async function matchCodePatterns(
  diffText: string,
): Promise<{ ruleId: number; matcherType: string; pattern: string }[]> {
  const result = await pool.query(`
    SELECT rm.*, cr.enabled
    FROM rule_matchers rm
    JOIN code_rules cr ON rm.rule_id = cr.id
    WHERE cr.enabled = TRUE
    ORDER BY rm.priority DESC
  `);
  const matchers: (RuleMatcher & { enabled: boolean })[] = result.rows;

  const matches: { ruleId: number; matcherType: string; pattern: string }[] = [];
  const matchedRuleIds = new Set<number>();

  for (const matcher of matchers) {
    if (matchedRuleIds.has(matcher.rule_id)) continue; // one match per rule is enough

    let matched = false;

    if (matcher.matcher_type === 'code_pattern') {
      if (matcher.is_regex) {
        try {
          const regex = new RegExp(matcher.pattern, 'im');
          matched = regex.test(diffText);
        } catch {
          // Invalid regex — skip
        }
      } else {
        // Plain text search (case-insensitive)
        matched = diffText.toLowerCase().includes(matcher.pattern.toLowerCase());
      }
    } else if (matcher.matcher_type === 'annotation') {
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
export async function matchFilePathsToRules(
  changedFiles: string[],
): Promise<{ ruleId: number; matcherType: string; pattern: string; filePath: string }[]> {
  const result = await pool.query(`
    SELECT rm.*
    FROM rule_matchers rm
    JOIN code_rules cr ON rm.rule_id = cr.id
    WHERE cr.enabled = TRUE
      AND rm.matcher_type IN ('file_glob', 'file_extension', 'directory')
    ORDER BY rm.priority DESC
  `);
  const matchers: RuleMatcher[] = result.rows;

  const matches: { ruleId: number; matcherType: string; pattern: string; filePath: string }[] = [];
  const matchedPairs = new Set<string>(); // ruleId:filePath

  for (const file of changedFiles) {
    for (const matcher of matchers) {
      const key = `${matcher.rule_id}:${file}`;
      if (matchedPairs.has(key)) continue;

      let matched = false;

      switch (matcher.matcher_type) {
        case 'file_glob':
          matched = minimatch(file, matcher.pattern, { dot: true, nocase: true });
          break;
        case 'file_extension': {
          const ext = file.split('.').pop()?.toLowerCase() || '';
          matched = ext === matcher.pattern.toLowerCase().replace(/^\./, '');
          break;
        }
        case 'directory':
          matched = file.startsWith(matcher.pattern) ||
            minimatch(file, matcher.pattern + '/**', { dot: true, nocase: true });
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
export async function getRulesByIds(ruleIds: number[]): Promise<(CodeRule & { domain_name: string; domain_display_name: string })[]> {
  if (ruleIds.length === 0) return [];
  const result = await pool.query(`
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
export async function resolveRulesForPR(
  changedFiles: string[],
  diffText: string,
): Promise<ResolvedRule[]> {
  const resolvedMap = new Map<number, ResolvedRule>();

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
  const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const rules = Array.from(resolvedMap.values());
  rules.sort((a, b) => (severityOrder[a.severity] ?? 99) - (severityOrder[b.severity] ?? 99));

  return rules;
}

// ---------------------------------------------------------------------------
// CRUD helpers for rules management
// ---------------------------------------------------------------------------

export async function createDomain(
  name: string, displayName: string, parentId: number | null, description?: string,
): Promise<CodeDomain> {
  const result = await pool.query(`
    INSERT INTO code_domains (name, display_name, parent_id, description)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [name, displayName, parentId, description || null]);
  return result.rows[0];
}

export async function createRule(
  domainId: number, ruleKey: string, title: string, description: string,
  severity: string = 'high', teamOwner?: string,
): Promise<CodeRule> {
  const result = await pool.query(`
    INSERT INTO code_rules (domain_id, rule_key, title, description, severity, team_owner)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `, [domainId, ruleKey, title, description, severity, teamOwner || null]);
  return result.rows[0];
}

export async function createRuleMatcher(
  ruleId: number, matcherType: string, pattern: string,
  isRegex: boolean = false, priority: number = 0,
): Promise<RuleMatcher> {
  const result = await pool.query(`
    INSERT INTO rule_matchers (rule_id, matcher_type, pattern, is_regex, priority)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [ruleId, matcherType, pattern, isRegex, priority]);
  return result.rows[0];
}

export async function createDomainFileMapping(
  domainId: number, filePattern: string, priority: number = 0,
): Promise<void> {
  await pool.query(`
    INSERT INTO domain_file_mappings (domain_id, file_pattern, priority)
    VALUES ($1, $2, $3)
  `, [domainId, filePattern, priority]);
}

export async function updateRule(
  ruleId: number,
  updates: Partial<Pick<CodeRule, 'title' | 'description' | 'severity' | 'enabled' | 'team_owner'>>,
): Promise<CodeRule | null> {
  const fields: string[] = [];
  const values: any[] = [];
  let paramIdx = 1;

  if (updates.title !== undefined) { fields.push(`title = $${paramIdx++}`); values.push(updates.title); }
  if (updates.description !== undefined) { fields.push(`description = $${paramIdx++}`); values.push(updates.description); }
  if (updates.severity !== undefined) { fields.push(`severity = $${paramIdx++}`); values.push(updates.severity); }
  if (updates.enabled !== undefined) { fields.push(`enabled = $${paramIdx++}`); values.push(updates.enabled); }
  if (updates.team_owner !== undefined) { fields.push(`team_owner = $${paramIdx++}`); values.push(updates.team_owner); }

  if (fields.length === 0) return null;
  fields.push(`updated_at = NOW()`);
  values.push(ruleId);

  const result = await pool.query(
    `UPDATE code_rules SET ${fields.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
    values,
  );
  return result.rows[0] || null;
}

export async function deleteRule(ruleId: number): Promise<boolean> {
  const result = await pool.query('DELETE FROM code_rules WHERE id = $1', [ruleId]);
  return (result.rowCount || 0) > 0;
}

export async function listRules(options?: {
  domainId?: number;
  teamOwner?: string;
  enabledOnly?: boolean;
}): Promise<(CodeRule & { domain_name: string; domain_display_name: string; matcher_count: number })[]> {
  const conditions: string[] = [];
  const values: any[] = [];
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

  const result = await pool.query(`
    SELECT cr.*, cd.name AS domain_name, cd.display_name AS domain_display_name,
           (SELECT COUNT(*) FROM rule_matchers rm WHERE rm.rule_id = cr.id) AS matcher_count
    FROM code_rules cr
    JOIN code_domains cd ON cr.domain_id = cd.id
    ${where}
    ORDER BY cd.name, cr.severity, cr.rule_key
  `, values);

  return result.rows;
}

// ---------------------------------------------------------------------------
// Domain taxonomy (for LLM classifier context)
// ---------------------------------------------------------------------------

export interface DomainTaxonomy {
  id: number;
  name: string;
  display_name: string;
  description: string | null;
  depth: number;
  rule_count: number;
}

/**
 * Get the full domain taxonomy with rule counts — used as context for the
 * LLM classifier when deterministic matching finds nothing.
 */
export async function getDomainTaxonomy(): Promise<DomainTaxonomy[]> {
  const result = await pool.query(`
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
