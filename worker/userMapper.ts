#!/usr/bin/env npx ts-node
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

import 'dotenv/config';
import axios from 'axios';
import { requireTokenForHost } from '../src/utils/gheTokenResolver';

const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [UserMapper] ${message}`);
}

function logError(message: string): void {
  console.error(`[${new Date().toISOString()}] [UserMapper] ${message}`);
}

interface GHEUser {
  login: string;
  email: string | null;
  name: string | null;
}

// ---------------------------------------------------------------------------
// Strategy 1: GHE email → Slack lookupByEmail
// ---------------------------------------------------------------------------

async function fetchGHEUserProfile(hostname: string, login: string): Promise<GHEUser | null> {
  try {
    const token = requireTokenForHost(hostname);
    const response = await axios.get(`https://${hostname}/api/v3/users/${login}`, {
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
  } catch (error: any) {
    logError(`Failed to fetch GHE profile for ${login}@${hostname}: ${error.message}`);
    return null;
  }
}

async function lookupSlackUserByEmail(email: string): Promise<{ id: string; name: string } | null> {
  if (!SLACK_BOT_TOKEN) return null;
  try {
    const response = await axios.get('https://slack.com/api/users.lookupByEmail', {
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
    return null;
  } catch (error: any) {
    logError(`Slack lookup failed for ${email}: ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: Correlate PR authors with Slack message posters
// ---------------------------------------------------------------------------

async function fetchTrackedPRsWithAuthors(): Promise<{ pr_url: string; org: string; repo: string; pr_number: number; channel_id: string; message_ts: string }[]> {
  const response = await axios.get(`${HEROKU_API_URL}/api/pending-prs`, {
    headers: { 'X-Worker-API-Key': WORKER_API_KEY },
    timeout: 30000,
  });
  return response.data.prs || [];
}

function extractHostname(prUrl: string): string | null {
  const match = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)/);
  return match ? match[1] : null;
}

async function fetchPRAuthor(hostname: string, org: string, repo: string, prNumber: number): Promise<string | null> {
  try {
    const token = requireTokenForHost(hostname);
    const response = await axios.get(
      `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
        timeout: 10000,
      },
    );
    return response.data.user?.login || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Report mappings to Heroku
// ---------------------------------------------------------------------------

async function reportUserMapping(mapping: {
  ghe_login: string;
  slack_user_id: string | null;
  display_name: string | null;
  email: string | null;
  discovered_via: string;
}): Promise<void> {
  await axios.post(
    `${HEROKU_API_URL}/api/user-mappings`,
    { mappings: [mapping] },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-API-Key': WORKER_API_KEY,
      },
      timeout: 30000,
    },
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  log('Starting user mapping discovery...');

  if (!HEROKU_API_URL || !WORKER_API_KEY) {
    logError('HEROKU_API_URL and WORKER_API_KEY are required');
    process.exit(1);
  }

  // Collect unique GHE logins from tracked PRs
  const gheLoginsToResolve = new Map<string, { hostname: string; login: string }>();

  // Fetch all tracked PRs and discover PR authors
  log('Fetching tracked PRs to discover authors...');
  let prs: { pr_url: string; org: string; repo: string; pr_number: number }[] = [];
  try {
    prs = await fetchTrackedPRsWithAuthors();
    log(`Found ${prs.length} tracked PRs`);
  } catch (error: any) {
    logError(`Failed to fetch tracked PRs: ${error.message}`);
  }

  for (const pr of prs) {
    const hostname = extractHostname(pr.pr_url);
    if (!hostname) continue;

    const author = await fetchPRAuthor(hostname, pr.org, pr.repo, pr.pr_number);
    if (author && !gheLoginsToResolve.has(author)) {
      gheLoginsToResolve.set(author, { hostname, login: author });
    }

    // Also fetch reviewers
    try {
      const token = requireTokenForHost(hostname);
      const reviewsResp = await axios.get(
        `https://${hostname}/api/v3/repos/${pr.org}/${pr.repo}/pulls/${pr.pr_number}/reviews`,
        {
          headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
          },
          timeout: 10000,
        },
      );
      for (const review of reviewsResp.data || []) {
        const login = review.user?.login;
        if (login && !gheLoginsToResolve.has(login)) {
          gheLoginsToResolve.set(login, { hostname, login });
        }
      }
    } catch {
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
    let slackUser: { id: string; name: string } | null = null;

    if (profile?.email && SLACK_BOT_TOKEN) {
      slackUser = await lookupSlackUserByEmail(profile.email);
    }

    try {
      await reportUserMapping({
        ghe_login: login,
        slack_user_id: slackUser?.id || null,
        display_name: slackUser?.name || profile?.name || null,
        email: profile?.email || null,
        discovered_via: slackUser ? 'email_lookup' : 'ghe_profile',
      });

      if (slackUser) {
        log(`  ✅ ${login} → Slack user ${slackUser.id} (${slackUser.name})`);
        mapped++;
      } else {
        log(`  ⚠️  ${login} → no Slack match (email: ${profile?.email || 'none'})`);
        unmapped++;
      }
    } catch (error: any) {
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
          slack_user_id: slackId as string,
          display_name: null,
          email: null,
          discovered_via: 'manual_config',
        });
        log(`  📝 ${gheLogin} → ${slackId} (manual)`);
      }
    } catch (e) {
      logError(`Failed to parse USER_MAPPINGS_JSON: ${e}`);
    }
  }

  log('User mapping complete.');
}

run().then(() => process.exit(0)).catch((error) => {
  logError(`Fatal error: ${error}`);
  process.exit(1);
});
