export interface ParsedPR {
    url: string;
    hostname: string;
    org: string;
    repo: string;
    prNumber: number;
}
/**
 * Parse PR URLs from a message text
 * Returns all unique PRs found in the message
 */
export declare function parsePRsFromMessage(text: string): ParsedPR[];
/**
 * Check if a message contains at least one PR link
 */
export declare function containsPRLink(text: string): boolean;
//# sourceMappingURL=prParser.d.ts.map