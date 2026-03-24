import type { RepoKnowledge } from '../db/client';
export interface CodeExample extends RepoKnowledge {
    domain_name: string;
    domain_display_name: string;
    similarity?: number;
}
export interface CodeContextOptions {
    domainIds: number[];
    changedFiles: string[];
    org?: string;
    repo?: string;
    elementTypes?: string[];
    limit?: number;
    maxPerFile?: number;
}
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
export declare function fetchDomainScopedCodeExamples(options: CodeContextOptions): Promise<CodeExample[]>;
/**
 * Format code examples for inclusion in LLM prompts.
 */
export declare function formatCodeExamplesForPrompt(examples: CodeExample[]): string;
//# sourceMappingURL=codeContextProvider.d.ts.map