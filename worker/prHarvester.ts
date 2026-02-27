#!/usr/bin/env npx ts-node
/**
 * PR History Harvester
 *
 * Fetches review comments, changed files, and diffs for PRs that were
 * posted in monitored Slack channels (from tracked_prs table).
 *
 * Usage:
 *   npm run harvest                  # Harvest only not-yet-harvested PRs
 *   npm run harvest:incremental      # Same as above (alias)
 *   HARVEST_ALL=1 npm run harvest    # Re-harvest all tracked PRs
 */

import 'dotenv/config';
import { notifyError } from '../src/utils/errorNotifier';
import axios from 'axios';
import { requireTokenForHost } from '../src/utils/gheTokenResolver';

const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const harvestAll = process.env.HARVEST_ALL === '1';

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [PRHarvester] ${message}`);
}

function logError(message: string, severity: 'warn' | 'error' | 'fatal' = 'error'): void {
  console.error(`[${new Date().toISOString()}] [PRHarvester] ${message}`);
  notifyError('PRHarvester', message, severity);
}

function herokuHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Worker-API-Key': WORKER_API_KEY!,
  };
}

function extractHostname(prUrl: string): string | null {
  const match = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// GHE API helpers
// ---------------------------------------------------------------------------

async function fetchPRDetails(
  hostname: string, org: string, repo: string, prNumber: number,
): Promise<any> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      timeout: 15000,
    },
  );
  return response.data;
}

async function fetchPRReviewComments(
  hostname: string, org: string, repo: string, prNumber: number,
): Promise<any[]> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/comments`,
    {
      params: { per_page: 100 },
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      timeout: 30000,
    },
  );
  return response.data || [];
}

async function fetchPRReviews(
  hostname: string, org: string, repo: string, prNumber: number,
): Promise<any[]> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/reviews`,
    {
      params: { per_page: 100 },
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      timeout: 30000,
    },
  );
  return response.data || [];
}

async function fetchPRFiles(
  hostname: string, org: string, repo: string, prNumber: number,
): Promise<any[]> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/files`,
    {
      params: { per_page: 100 },
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      timeout: 30000,
    },
  );
  return response.data || [];
}

// ---------------------------------------------------------------------------
// Heroku API helpers
// ---------------------------------------------------------------------------

interface TrackedPR {
  pr_url: string;
  org: string;
  repo: string;
  pr_number: number;
  channel_id: string;
  message_ts: string;
}

async function fetchTrackedPRs(): Promise<TrackedPR[]> {
  const endpoint = harvestAll ? '/api/all-tracked-prs' : '/api/tracked-prs-for-harvest';
  const response = await axios.get(`${HEROKU_API_URL}${endpoint}`, {
    headers: { 'X-Worker-API-Key': WORKER_API_KEY },
    timeout: 30000,
  });
  return response.data.prs || [];
}

async function reportHarvestData(data: {
  reviews: any[];
  files: any[];
}): Promise<void> {
  await axios.post(`${HEROKU_API_URL}/api/harvest-data`, data, {
    headers: herokuHeaders(),
    timeout: 60000,
  });
}

// ---------------------------------------------------------------------------
// Harvest a single PR
// ---------------------------------------------------------------------------

async function harvestPR(pr: TrackedPR): Promise<{ reviews: number; files: number }> {
  const hostname = extractHostname(pr.pr_url);
  if (!hostname) {
    logError(`  Cannot extract hostname from ${pr.pr_url}`);
    return { reviews: 0, files: 0 };
  }

  const { org, repo, pr_number: prNumber, pr_url: prUrl } = pr;

  // Get PR author
  let prAuthor = '';
  try {
    const details = await fetchPRDetails(hostname, org, repo, prNumber);
    prAuthor = details.user?.login || '';
    log(`  PR #${prNumber}: "${details.title}" by ${prAuthor}`);
  } catch (error: any) {
    log(`  PR #${prNumber}: could not fetch details (${error.message}), continuing...`);
  }

  const reviews: any[] = [];
  const files: any[] = [];

  // Fetch inline review comments (diff comments)
  try {
    const comments = await fetchPRReviewComments(hostname, org, repo, prNumber);
    for (const comment of comments) {
      reviews.push({
        pr_url: prUrl,
        pr_number: prNumber,
        org,
        repo,
        reviewer_login: comment.user?.login || 'unknown',
        file_path: comment.path || null,
        diff_hunk: comment.diff_hunk ? comment.diff_hunk.substring(0, 2000) : null,
        comment_body: comment.body || '',
        review_state: 'COMMENTED',
        submitted_at: comment.created_at || null,
      });
    }
  } catch (error: any) {
    logError(`    Failed to fetch review comments: ${error.message}`);
  }

  // Fetch top-level reviews (APPROVED, CHANGES_REQUESTED, etc.)
  try {
    const topReviews = await fetchPRReviews(hostname, org, repo, prNumber);
    for (const review of topReviews) {
      if (review.body && review.body.trim().length > 0) {
        reviews.push({
          pr_url: prUrl,
          pr_number: prNumber,
          org,
          repo,
          reviewer_login: review.user?.login || 'unknown',
          file_path: null,
          diff_hunk: null,
          comment_body: review.body,
          review_state: review.state || 'COMMENTED',
          submitted_at: review.submitted_at || null,
        });
      }
    }
  } catch (error: any) {
    logError(`    Failed to fetch reviews: ${error.message}`);
  }

  // Fetch changed files
  try {
    const prFiles = await fetchPRFiles(hostname, org, repo, prNumber);
    for (const file of prFiles) {
      files.push({
        pr_url: prUrl,
        pr_number: prNumber,
        org,
        repo,
        file_path: file.filename,
        change_type: file.status || 'modified',
        additions: file.additions || 0,
        deletions: file.deletions || 0,
        patch_snippet: file.patch ? file.patch.substring(0, 3000) : null,
        author_login: prAuthor,
      });
    }
  } catch (error: any) {
    logError(`    Failed to fetch files: ${error.message}`);
  }

  // Report to Heroku
  if (reviews.length > 0 || files.length > 0) {
    try {
      await reportHarvestData({ reviews, files });
    } catch (error: any) {
      logError(`    Failed to report harvest data: ${error.message}`);
    }
  }

  return { reviews: reviews.length, files: files.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  log('='.repeat(60));
  log(`PR History Harvester starting (${harvestAll ? 'full' : 'incremental'} mode)...`);
  log('='.repeat(60));

  if (!HEROKU_API_URL || !WORKER_API_KEY) {
    logError('HEROKU_API_URL and WORKER_API_KEY are required');
    process.exit(1);
  }

  if (!process.env.GHE_TOKEN && !process.env.GHE_TOKENS) {
    logError('GHE_TOKEN or GHE_TOKENS is required');
    process.exit(1);
  }

  let prs: TrackedPR[];
  try {
    prs = await fetchTrackedPRs();
    log(`Found ${prs.length} PR(s) to harvest`);
  } catch (error: any) {
    logError(`Failed to fetch tracked PRs: ${error.message}`);
    process.exit(1);
    return;
  }

  if (prs.length === 0) {
    log('No PRs to harvest. All tracked PRs have already been harvested.');
    return;
  }

  let totalReviews = 0;
  let totalFiles = 0;

  for (const pr of prs) {
    log(`Harvesting ${pr.org}/${pr.repo}#${pr.pr_number}...`);
    try {
      const result = await harvestPR(pr);
      totalReviews += result.reviews;
      totalFiles += result.files;
      log(`  ✅ ${result.reviews} reviews, ${result.files} files`);
    } catch (error: any) {
      logError(`  Failed: ${error.message}`);
    }

    // Rate limit between PRs
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  log('='.repeat(60));
  log(`Harvest complete! ${prs.length} PRs → ${totalReviews} reviews, ${totalFiles} files`);
  log('='.repeat(60));
}

run().then(() => process.exit(0)).catch((error) => {
  logError(`Fatal error: ${error}`);
  process.exit(1);
});
