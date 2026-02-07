export interface ParsedPR {
  url: string;
  hostname: string;  // e.g., "gitcore.soma.salesforce.com"
  org: string;
  repo: string;
  prNumber: number;
}

// Regex to match GitHub Enterprise PR URLs
// Matches any subdomain: https://*.soma.salesforce.com/{org}/{repo}/pull/{number}
// Examples: git.soma, gitcore.soma, gus.soma, etc.
// Captures: (1) hostname, (2) org, (3) repo, (4) prNumber
const GHE_PR_REGEX = /https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/g;

/**
 * Parse PR URLs from a message text
 * Returns all unique PRs found in the message
 */
export function parsePRsFromMessage(text: string): ParsedPR[] {
  const prs: ParsedPR[] = [];
  const seen = new Set<string>();
  
  let match: RegExpExecArray | null;
  
  // Reset regex state
  GHE_PR_REGEX.lastIndex = 0;
  
  while ((match = GHE_PR_REGEX.exec(text)) !== null) {
    const url = match[0];
    
    // Skip duplicates in the same message
    if (seen.has(url)) continue;
    seen.add(url);
    
    prs.push({
      url,
      hostname: match[1],
      org: match[2],
      repo: match[3],
      prNumber: parseInt(match[4], 10),
    });
  }
  
  return prs;
}

/**
 * Check if a message contains at least one PR link
 */
export function containsPRLink(text: string): boolean {
  GHE_PR_REGEX.lastIndex = 0;
  return GHE_PR_REGEX.test(text);
}
