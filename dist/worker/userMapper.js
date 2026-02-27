#!/usr/bin/env npx ts-node
"use strict";
/**
 * GHE → Slack User Mapper
 *
 * Discovers mappings between GitHub Enterprise logins and Slack user IDs.
 *
 * Strategies:
 *   1. GHE user email → Slack users.lookupByEmail
 *   2. PR author correlation: match Slack message poster with GHE PR author
 *   3. Manual config fallback (USER_MAPPINGS_JSON env var or user_mappings.json)
 *
 * Usage:
 *   npm run map-users
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const errorNotifier_1 = require("../src/utils/errorNotifier");
const axios_1 = __importDefault(require("axios"));
const gheTokenResolver_1 = require("../src/utils/gheTokenResolver");
const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
function log(message) {
    console.log(`[${new Date().toISOString()}] [UserMapper] ${message}`);
}
function logError(message, severity = 'error') {
    console.error(`[${new Date().toISOString()}] [UserMapper] ${message}`);
    (0, errorNotifier_1.notifyError)('UserMapper', message, severity);
}
// ---------------------------------------------------------------------------
// Strategy 1: GHE email → Slack lookupByEmail
// ---------------------------------------------------------------------------
async function fetchGHEUserProfile(hostname, login) {
    try {
        const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
        const response = await axios_1.default.get(`https://${hostname}/api/v3/users/${login}`, {
            headers: {
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github.v3+json',
            },
            timeout: 10000,
        });
        return {
            login: response.data.login,
            email: response.data.email || null,
            name: response.data.name || null,
        };
    }
    catch (error) {
        logError(`Failed to fetch GHE profile for ${login}@${hostname}: ${error.message}`);
        return null;
    }
}
async function lookupSlackUserByEmail(email) {
    if (!SLACK_BOT_TOKEN)
        return null;
    try {
        const response = await axios_1.default.get('https://slack.com/api/users.lookupByEmail', {
            params: { email },
            headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
            timeout: 10000,
        });
        if (response.data.ok && response.data.user) {
            return {
                id: response.data.user.id,
                name: response.data.user.real_name || response.data.user.name,
            };
        }
        if (!response.data.ok) {
            log(`    Slack email lookup returned: ${response.data.error || 'unknown error'}`);
        }
        return null;
    }
    catch (error) {
        logError(`Slack lookup failed for ${email}: ${error.message}`);
        return null;
    }
}
// Cached Slack user list for name-based fallback
let slackUsersCache = null;
async function loadSlackUsers() {
    if (slackUsersCache)
        return slackUsersCache;
    if (!SLACK_BOT_TOKEN)
        return null;
    log('  Loading Slack user list for name-based matching...');
    const allUsers = [];
    let cursor;
    do {
        try {
            const response = await axios_1.default.get('https://slack.com/api/users.list', {
                params: { limit: 200, cursor },
                headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
                timeout: 30000,
            });
            if (!response.data.ok) {
                logError(`  Slack users.list failed: ${response.data.error}`);
                break;
            }
            for (const member of response.data.members || []) {
                if (member.deleted || member.is_bot)
                    continue;
                allUsers.push({
                    id: member.id,
                    real_name: (member.real_name || '').toLowerCase(),
                    display_name: (member.profile?.display_name || '').toLowerCase(),
                });
            }
            cursor = response.data.response_metadata?.next_cursor;
            // Rate limit
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        catch (error) {
            logError(`  Failed to fetch Slack users list: ${error.message}`);
            break;
        }
    } while (cursor);
    log(`  Loaded ${allUsers.length} Slack users for name matching`);
    slackUsersCache = allUsers;
    return slackUsersCache;
}
async function lookupSlackUserByName(gheName) {
    const users = await loadSlackUsers();
    if (!users || !gheName)
        return null;
    const nameLC = gheName.toLowerCase().trim();
    // Exact match on real_name or display_name
    const exact = users.find(u => u.real_name === nameLC || u.display_name === nameLC);
    if (exact)
        return { id: exact.id, name: exact.real_name };
    // Fuzzy: check if all parts of the GHE name appear in a Slack real_name
    const parts = nameLC.split(/\s+/);
    if (parts.length >= 2) {
        const match = users.find(u => parts.every(p => u.real_name.includes(p)));
        if (match)
            return { id: match.id, name: match.real_name };
    }
    return null;
}
// ---------------------------------------------------------------------------
// Strategy 2: Correlate PR authors with Slack message posters
// ---------------------------------------------------------------------------
async function fetchTrackedPRsWithAuthors() {
    const response = await axios_1.default.get(`${HEROKU_API_URL}/api/pending-prs`, {
        headers: { 'X-Worker-API-Key': WORKER_API_KEY },
        timeout: 30000,
    });
    return response.data.prs || [];
}
function extractHostname(prUrl) {
    const match = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)/);
    return match ? match[1] : null;
}
async function fetchPRAuthor(hostname, org, repo, prNumber) {
    try {
        const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
        const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`, {
            headers: {
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github.v3+json',
            },
            timeout: 10000,
        });
        return response.data.user?.login || null;
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Report mappings to Heroku
// ---------------------------------------------------------------------------
async function reportUserMapping(mapping) {
    await axios_1.default.post(`${HEROKU_API_URL}/api/user-mappings`, { mappings: [mapping] }, {
        headers: {
            'Content-Type': 'application/json',
            'X-Worker-API-Key': WORKER_API_KEY,
        },
        timeout: 30000,
    });
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
    log('Starting user mapping discovery...');
    if (!HEROKU_API_URL || !WORKER_API_KEY) {
        logError('HEROKU_API_URL and WORKER_API_KEY are required');
        process.exit(1);
    }
    // Collect unique GHE logins from tracked PRs
    const gheLoginsToResolve = new Map();
    // Fetch all tracked PRs and discover PR authors
    log('Fetching tracked PRs to discover authors...');
    let prs = [];
    try {
        prs = await fetchTrackedPRsWithAuthors();
        log(`Found ${prs.length} tracked PRs`);
    }
    catch (error) {
        logError(`Failed to fetch tracked PRs: ${error.message}`);
    }
    for (const pr of prs) {
        const hostname = extractHostname(pr.pr_url);
        if (!hostname)
            continue;
        const author = await fetchPRAuthor(hostname, pr.org, pr.repo, pr.pr_number);
        if (author && !gheLoginsToResolve.has(author)) {
            gheLoginsToResolve.set(author, { hostname, login: author });
        }
        // Also fetch reviewers
        try {
            const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
            const reviewsResp = await axios_1.default.get(`https://${hostname}/api/v3/repos/${pr.org}/${pr.repo}/pulls/${pr.pr_number}/reviews`, {
                headers: {
                    Authorization: `token ${token}`,
                    Accept: 'application/vnd.github.v3+json',
                },
                timeout: 10000,
            });
            for (const review of reviewsResp.data || []) {
                const login = review.user?.login;
                if (login && !gheLoginsToResolve.has(login)) {
                    gheLoginsToResolve.set(login, { hostname, login });
                }
            }
        }
        catch {
            // Skip on error
        }
        // Rate limit
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    log(`Discovered ${gheLoginsToResolve.size} unique GHE logins`);
    // Resolve each login
    let mapped = 0;
    let unmapped = 0;
    for (const [login, { hostname }] of gheLoginsToResolve) {
        log(`Resolving ${login}...`);
        // Strategy 1: GHE profile email → Slack
        const profile = await fetchGHEUserProfile(hostname, login);
        let slackUser = null;
        log(`  GHE profile: name="${profile?.name || 'none'}", email="${profile?.email || 'none'}"`);
        if (profile?.email && SLACK_BOT_TOKEN) {
            slackUser = await lookupSlackUserByEmail(profile.email);
        }
        // Strategy 1b: Fallback to name-based matching
        if (!slackUser && profile?.name && SLACK_BOT_TOKEN) {
            log(`  Trying name-based fallback for "${profile.name}"...`);
            slackUser = await lookupSlackUserByName(profile.name);
            if (slackUser) {
                log(`  Found via name match!`);
            }
        }
        try {
            await reportUserMapping({
                ghe_login: login,
                slack_user_id: slackUser?.id || null,
                display_name: slackUser?.name || profile?.name || null,
                email: profile?.email || null,
                discovered_via: slackUser ? (profile?.email ? 'email_lookup' : 'name_lookup') : 'ghe_profile',
            });
            if (slackUser) {
                log(`  ✅ ${login} → Slack user ${slackUser.id} (${slackUser.name})`);
                mapped++;
            }
            else {
                log(`  ⚠️  ${login} → no Slack match (email: ${profile?.email || 'none'})`);
                unmapped++;
            }
        }
        catch (error) {
            logError(`  Failed to report mapping for ${login}: ${error.message}`);
            unmapped++;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    log(`Done! Mapped: ${mapped}, Unmapped: ${unmapped}`);
    // Strategy 3: Manual config fallback
    const manualMappingsJson = process.env.USER_MAPPINGS_JSON;
    if (manualMappingsJson) {
        try {
            const manualMappings = JSON.parse(manualMappingsJson);
            log(`Applying ${Object.keys(manualMappings).length} manual mapping(s)...`);
            for (const [gheLogin, slackId] of Object.entries(manualMappings)) {
                await reportUserMapping({
                    ghe_login: gheLogin,
                    slack_user_id: slackId,
                    display_name: null,
                    email: null,
                    discovered_via: 'manual_config',
                });
                log(`  📝 ${gheLogin} → ${slackId} (manual)`);
            }
        }
        catch (e) {
            logError(`Failed to parse USER_MAPPINGS_JSON: ${e}`);
        }
    }
    log('User mapping complete.');
}
run().then(() => process.exit(0)).catch((error) => {
    logError(`Fatal error: ${error}`);
    process.exit(1);
});
//# sourceMappingURL=userMapper.js.map