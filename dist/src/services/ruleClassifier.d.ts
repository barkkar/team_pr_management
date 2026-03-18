/**
 * Rule Classifier (LLM Fallback)
 *
 * When the deterministic ontology engine finds zero rules for a file,
 * this classifier uses the existing Ollama LLM to classify the code diff
 * into domain categories, then fetches exact rules for those domains.
 *
 * This is structured classification with a fixed taxonomy — NOT vector similarity.
 */
import { DomainTaxonomy, ResolvedRule } from './ontologyEngine';
/**
 * Ask the LLM to classify a code diff into one or more domains from the
 * ontology taxonomy. Returns domain IDs.
 *
 * This is called ONLY when deterministic matching finds no rules for a file.
 */
export declare function classifyDiffIntoDomains(filePath: string, diffSnippet: string, taxonomy?: DomainTaxonomy[]): Promise<number[]>;
/**
 * Full fallback pipeline: classify a file diff via LLM and return its exact rules.
 */
export declare function classifyAndResolveRules(filePath: string, diffSnippet: string, taxonomy?: DomainTaxonomy[]): Promise<ResolvedRule[]>;
/**
 * For a set of files that had no deterministic matches, run LLM classification
 * on each and merge the results. Deduplicates rules across files.
 */
export declare function classifyUnmatchedFiles(unmatchedFiles: {
    filePath: string;
    diffSnippet: string;
}[]): Promise<ResolvedRule[]>;
//# sourceMappingURL=ruleClassifier.d.ts.map