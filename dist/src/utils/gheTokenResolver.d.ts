/**
 * GHE Token Resolver
 *
 * Resolves the correct GitHub Enterprise personal access token for a given
 * hostname. Supports multiple GHE instances (e.g., gitcore.soma.salesforce.com
 * and git.soma.salesforce.com) each with their own token.
 *
 * Configuration:
 *   GHE_TOKENS - JSON map of hostname -> token (preferred for multi-host)
 *                e.g. {"gitcore.soma.salesforce.com":"ghp_abc","git.soma.salesforce.com":"ghp_xyz"}
 *   GHE_TOKEN  - Single token used as a fallback when GHE_TOKENS is not set
 *                or when a hostname has no entry in the map.
 */
/**
 * Returns the GHE token for the given hostname.
 * Checks GHE_TOKENS map first, then falls back to GHE_TOKEN.
 * Returns null if no token is available.
 */
export declare function getTokenForHost(hostname: string): string | null;
/**
 * Returns the GHE token for the given hostname, or throws if none is configured.
 */
export declare function requireTokenForHost(hostname: string): string;
//# sourceMappingURL=gheTokenResolver.d.ts.map