#!/usr/bin/env npx ts-node
"use strict";
/**
 * Channel Bootstrap Drain Worker
 *
 * Drains the `channel_bootstrap_queue` by resolving Slack-member emails to
 * GHE logins via the configured GHE hosts. Runs on the VPN-connected laptop
 * because only it can reach GHE.
 *
 * Per-tick flow (one batch):
 *   1. POST /api/bootstrap-claim  -> BootstrapClaim[]
 *   2. For each row: search each configured host for the email, then fetch
 *      the user to confirm the email matches. First match wins.
 *   3. POST /api/bootstrap-complete with BootstrapResult[]
 *
 * See docs/superpowers/specs/2026-05-04-multi-team-user-mapping-design.md §5.3.
 *
 * Usage:
 *   npx ts-node worker/channelBootstrap.ts   # one-shot drain; exits when done
 *   (localPRChecker will call runBootstrapDrainLoop() from its tick in Packet F.)
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBootstrapDrainLoop = runBootstrapDrainLoop;
require("dotenv/config");
const axios_1 = __importDefault(require("axios"));
const errorNotifier_1 = require("../src/utils/errorNotifier");
const gheTokenResolver_1 = require("../src/utils/gheTokenResolver");
const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
// Pacing between rows in milliseconds. Defaults to 2100ms to stay comfortably
// under GHE secondary-rate-limit thresholds for unauthenticated-ish search.
const RAW_PACE_MS = parseInt(process.env.CHANNEL_BOOTSTRAP_PACE_MS || '2100', 10);
const PACE_MS = Number.isFinite(RAW_PACE_MS) && RAW_PACE_MS >= 0 ? RAW_PACE_MS : 2100;
const CLAIM_LIMIT = 50;
const TRANSIENT_NETWORK_CODES = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ENETUNREACH',
    'EAI_AGAIN',
]);
function isTransientHttpError(err) {
    if (!err)
        return false;
    const code = err.code;
    if (code && TRANSIENT_NETWORK_CODES.has(code))
        return true;
    const status = err.response?.status;
    if (status === 429 || status === 403)
        return true;
    if (typeof status === 'number' && status >= 500 && status <= 599)
        return true;
    return false;
}
function log(message) {
    console.log(`[${new Date().toISOString()}] [ChannelBootstrap] ${message}`);
}
function logError(message, severity = 'error') {
    console.error(`[${new Date().toISOString()}] [ChannelBootstrap] ${message}`);
    (0, errorNotifier_1.notifyError)('ChannelBootstrap', message, severity);
}
function herokuHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-Worker-API-Key': WORKER_API_KEY,
    };
}
// ---------------------------------------------------------------------------
// Per-row resolution
// ---------------------------------------------------------------------------
/**
 * Attempt to resolve one queue row across every configured GHE host, in
 * insertion order. Returns a BootstrapResult describing the outcome.
 *
 * `probedHosts` is shared across the tick so we only log rate-limit headers
 * once per host per tick.
 */
async function resolveRow(row, probedHosts) {
    const hosts = (0, gheTokenResolver_1.listConfiguredHosts)();
    const emailLower = row.email.toLowerCase();
    for (const host of hosts) {
        try {
            const token = (0, gheTokenResolver_1.requireTokenForHost)(host);
            const authHeaders = { Authorization: `token ${token}`, Accept: 'application/vnd.github.v3+json' };
            // Query: "<email> in:email" — URL-encode the email portion then append
            // the qualifier. Using raw `+` preserves the GitHub query syntax.
            const q = `${encodeURIComponent(row.email)}+in%3Aemail`;
            const searchUrl = `https://${host}/api/v3/search/users?q=${q}&per_page=1`;
            const searchResp = await axios_1.default.get(searchUrl, { headers: authHeaders, timeout: 10000 });
            // Log X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset on
            // the first search call to this host this tick. axios normalises header
            // keys to lowercase, hence the lookups below.
            if (!probedHosts.has(host)) {
                probedHosts.add(host);
                const h = searchResp.headers || {};
                log(`rate-limit ${host} limit=${h['x-ratelimit-limit'] ?? '?'} ` +
                    `remaining=${h['x-ratelimit-remaining'] ?? '?'} ` +
                    `reset=${h['x-ratelimit-reset'] ?? '?'}`);
            }
            const totalCount = searchResp.data?.total_count ?? 0;
            if (totalCount < 1) {
                continue;
            }
            const firstItem = searchResp.data?.items?.[0];
            const login = firstItem?.login;
            if (!login) {
                continue;
            }
            const userResp = await axios_1.default.get(`https://${host}/api/v3/users/${login}`, {
                headers: authHeaders,
                timeout: 10000,
            });
            const userEmail = userResp.data?.email ?? null;
            if (userEmail && userEmail.toLowerCase() === emailLower) {
                const displayName = userResp.data?.name ?? null;
                log(`resolved ${row.email} -> ${login} (${host})`);
                return {
                    id: row.id,
                    status: 'resolved',
                    ghe_login: login,
                    email: row.email,
                    display_name: displayName,
                    slack_user_id: row.slack_user_id,
                };
            }
            // Email mismatch — try next host.
        }
        catch (err) {
            if (!isTransientHttpError(err)) {
                // Unrecognized error — almost certainly a bug or misconfiguration, not
                // a transient failure. Let the outer drain catch handle it instead of
                // silently classifying as `pending` and burning retries.
                throw err;
            }
            // Catch-and-continue: one row's transient failure must not abort the batch (spec §5.3 step 2).
            const status = err?.response?.status;
            const msg = err?.message || String(err);
            const detailedError = status ? `${host} ${status}: ${msg}` : `${host}: ${msg}`;
            log(`pending ${row.email} — transient error: ${detailedError}`);
            return {
                id: row.id,
                status: 'pending',
                attempts_delta: 1,
                last_error: detailedError,
            };
        }
    }
    log(`unresolved ${row.email} (${hosts.length} hosts checked)`);
    return { id: row.id, status: 'unresolved' };
}
// ---------------------------------------------------------------------------
// Main drain loop (one batch per call)
// ---------------------------------------------------------------------------
/**
 * Run a single bootstrap-drain batch: claim up to 50 rows, resolve each, and
 * POST the results back. Safe to call from another worker — throws on fatal
 * configuration/transport errors but never on per-row failures.
 */
async function runBootstrapDrainLoop() {
    if (!HEROKU_API_URL || !WORKER_API_KEY) {
        throw new Error('HEROKU_API_URL and WORKER_API_KEY are required');
    }
    try {
        // 1. Claim a batch of rows.
        const claimResp = await axios_1.default.post(`${HEROKU_API_URL}/api/bootstrap-claim`, { limit: CLAIM_LIMIT }, { headers: herokuHeaders(), timeout: 30000 });
        const rows = claimResp.data?.rows || [];
        if (rows.length === 0) {
            log('No bootstrap rows to drain.');
            return;
        }
        log(`Claimed ${rows.length} bootstrap row(s).`);
        // 2. Resolve each row; pace between rows.
        const probedHosts = new Set();
        const results = [];
        let unresolvedCount = 0;
        const distinctChannels = new Set();
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const result = await resolveRow(row, probedHosts);
            results.push(result);
            if (result.status === 'unresolved') {
                unresolvedCount++;
                distinctChannels.add(row.channel_id);
            }
            // Pace between rows, but not after the last row.
            if (i < rows.length - 1) {
                await new Promise(r => setTimeout(r, PACE_MS));
            }
        }
        // 3. Unresolved-ratio alert. Stable message so notifyError's throttle bites
        //    on repeats; detailed varying counts go to stdout.
        if (rows.length >= 4 && unresolvedCount / rows.length > 0.5) {
            (0, errorNotifier_1.notifyError)('ChannelBootstrap', 'High unresolved ratio on bootstrap drain', 'warn');
            log(`unresolved=${unresolvedCount}/${rows.length} ` +
                `channels=${[...distinctChannels].join(',')}`);
        }
        // 4. Report results back.
        await axios_1.default.post(`${HEROKU_API_URL}/api/bootstrap-complete`, { results }, { headers: herokuHeaders(), timeout: 30000 });
        log(`Reported ${results.length} result(s) to Heroku.`);
    }
    catch (err) {
        // Stdout only: the caller (worker/localPRChecker.ts) owns Slack notification
        // to avoid double-notify. See plan Packet F.
        const msg = err?.message || String(err);
        log(`Drain batch failed: ${msg}`);
        throw err;
    }
}
// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
if (require.main === module) {
    if (!HEROKU_API_URL || !WORKER_API_KEY) {
        console.error(`[${new Date().toISOString()}] [ChannelBootstrap] HEROKU_API_URL and WORKER_API_KEY are required`);
        process.exit(1);
    }
    runBootstrapDrainLoop()
        .then(() => process.exit(0))
        .catch(err => {
        console.error(err);
        process.exit(1);
    });
}
//# sourceMappingURL=channelBootstrap.js.map