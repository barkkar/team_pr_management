"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTokenForHost = getTokenForHost;
exports.requireTokenForHost = requireTokenForHost;
let tokenMap = null;
function loadTokenMap() {
    if (tokenMap)
        return tokenMap;
    tokenMap = new Map();
    const gheTokensRaw = process.env.GHE_TOKENS;
    if (gheTokensRaw) {
        try {
            const parsed = JSON.parse(gheTokensRaw);
            for (const [hostname, token] of Object.entries(parsed)) {
                if (typeof token === 'string' && token.length > 0) {
                    tokenMap.set(hostname.toLowerCase(), token);
                }
            }
            console.log(`[GHE Token Resolver] Loaded tokens for ${tokenMap.size} hostname(s): ${[...tokenMap.keys()].join(', ')}`);
        }
        catch (e) {
            console.error('[GHE Token Resolver] Failed to parse GHE_TOKENS as JSON. Expected format: {"hostname":"token",...}');
        }
    }
    return tokenMap;
}
/**
 * Returns the GHE token for the given hostname.
 * Checks GHE_TOKENS map first, then falls back to GHE_TOKEN.
 * Returns null if no token is available.
 */
function getTokenForHost(hostname) {
    const map = loadTokenMap();
    const mapped = map.get(hostname.toLowerCase());
    if (mapped)
        return mapped;
    return process.env.GHE_TOKEN || null;
}
/**
 * Returns the GHE token for the given hostname, or throws if none is configured.
 */
function requireTokenForHost(hostname) {
    const token = getTokenForHost(hostname);
    if (!token) {
        throw new Error(`No GHE token configured for hostname "${hostname}". ` +
            `Set GHE_TOKENS (JSON map) or GHE_TOKEN (single fallback).`);
    }
    return token;
}
//# sourceMappingURL=gheTokenResolver.js.map