/**
 * Ontology Engine
 *
 * Deterministic rule resolver that maps changed files and code patterns
 * to exact coding rules via the ontology graph (code_domains, code_rules,
 * rule_matchers, domain_file_mappings).
 *
 * Replaces fuzzy vector-similarity retrieval for rule lookup.
 */
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
    matched_via: string;
    match_detail: string;
    domain_name: string;
    domain_display_name: string;
}
/**
 * Get all domains as a flat list.
 */
export declare function getAllDomains(): Promise<CodeDomain[]>;
/**
 * Get a domain and all its ancestors (recursive CTE walk up the tree).
 */
export declare function getDomainWithAncestors(domainId: number): Promise<CodeDomain[]>;
/**
 * Get a domain and all its descendants (recursive CTE walk down the tree).
 */
export declare function getDomainWithDescendants(domainId: number): Promise<CodeDomain[]>;
/**
 * Match changed file paths against domain_file_mappings to find applicable domains.
 * Uses glob matching (via minimatch) for flexibility.
 */
export declare function matchFilePathsToDomains(changedFiles: string[]): Promise<{
    domainId: number;
    filePath: string;
    pattern: string;
}[]>;
/**
 * Get all enabled rules for a set of domain IDs, including rules inherited
 * from ancestor domains (walk up the tree).
 */
export declare function getRulesForDomains(domainIds: number[]): Promise<(CodeRule & {
    domain_name: string;
    domain_display_name: string;
})[]>;
/**
 * Scan diff text against rule_matchers to find directly triggered rules.
 * Supports both regex and glob patterns.
 */
export declare function matchCodePatterns(diffText: string): Promise<{
    ruleId: number;
    matcherType: string;
    pattern: string;
}[]>;
/**
 * Match changed file paths directly against rule_matchers of type 'file_glob',
 * 'file_extension', and 'directory'.
 */
export declare function matchFilePathsToRules(changedFiles: string[]): Promise<{
    ruleId: number;
    matcherType: string;
    pattern: string;
    filePath: string;
}[]>;
/**
 * Fetch full rule objects by their IDs.
 */
export declare function getRulesByIds(ruleIds: number[]): Promise<(CodeRule & {
    domain_name: string;
    domain_display_name: string;
})[]>;
/**
 * Resolve all applicable rules for a PR given its changed files and diff text.
 * This is the main entry point — deterministic, no vector search.
 *
 * Returns a deduplicated, severity-sorted list of rules with match metadata.
 */
export declare function resolveRulesForPR(changedFiles: string[], diffText: string): Promise<ResolvedRule[]>;
export declare function createDomain(name: string, displayName: string, parentId: number | null, description?: string): Promise<CodeDomain>;
export declare function createRule(domainId: number, ruleKey: string, title: string, description: string, severity?: string, teamOwner?: string): Promise<CodeRule>;
export declare function createRuleMatcher(ruleId: number, matcherType: string, pattern: string, isRegex?: boolean, priority?: number): Promise<RuleMatcher>;
export declare function createDomainFileMapping(domainId: number, filePattern: string, priority?: number): Promise<void>;
export declare function updateRule(ruleId: number, updates: Partial<Pick<CodeRule, 'title' | 'description' | 'severity' | 'enabled' | 'team_owner'>>): Promise<CodeRule | null>;
export declare function deleteRule(ruleId: number): Promise<boolean>;
export declare function listRules(options?: {
    domainId?: number;
    teamOwner?: string;
    enabledOnly?: boolean;
}): Promise<(CodeRule & {
    domain_name: string;
    domain_display_name: string;
    matcher_count: number;
})[]>;
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
export declare function getDomainTaxonomy(): Promise<DomainTaxonomy[]>;
//# sourceMappingURL=ontologyEngine.d.ts.map