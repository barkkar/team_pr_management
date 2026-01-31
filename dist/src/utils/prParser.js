"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePRsFromMessage = parsePRsFromMessage;
exports.containsPRLink = containsPRLink;
// Regex to match GitHub Enterprise PR URLs
// Matches: https://git.soma.salesforce.com/{org}/{repo}/pull/{number}
const GHE_PR_REGEX = /https:\/\/git\.soma\.salesforce\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/g;
/**
 * Parse PR URLs from a message text
 * Returns all unique PRs found in the message
 */
function parsePRsFromMessage(text) {
    const prs = [];
    const seen = new Set();
    let match;
    // Reset regex state
    GHE_PR_REGEX.lastIndex = 0;
    while ((match = GHE_PR_REGEX.exec(text)) !== null) {
        const url = match[0];
        // Skip duplicates in the same message
        if (seen.has(url))
            continue;
        seen.add(url);
        prs.push({
            url,
            org: match[1],
            repo: match[2],
            prNumber: parseInt(match[3], 10),
        });
    }
    return prs;
}
/**
 * Check if a message contains at least one PR link
 */
function containsPRLink(text) {
    GHE_PR_REGEX.lastIndex = 0;
    return GHE_PR_REGEX.test(text);
}
//# sourceMappingURL=prParser.js.map