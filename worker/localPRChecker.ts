#!/usr/bin/env npx ts-node
/**
 * Local PR Status Checker Worker
 * 
 * This script runs on your local machine (behind VPN) to check PR status
 * from GitHub Enterprise and report back to the Heroku app.
 * 
 * Usage:
 *   npm run worker          # Run once
 *   npm run worker:watch    # Run every 5 minutes
 * 
 * Required environment variables:
 *   HEROKU_API_URL    - URL of your Heroku app (e.g., https://pr-manager.herokuapp.com)
 *   WORKER_API_KEY    - API key for authentication (must match Heroku config)
 *   GHE_TOKEN         - GitHub Enterprise personal access token (single-host fallback)
 *   GHE_TOKENS        - JSON map of hostname->token for multi-host (optional, preferred)
 */

import 'dotenv/config';
import axios from 'axios';
import { requireTokenForHost } from '../src/utils/gheTokenResolver';

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

function logError(message: string): void {
  console.error(`[${new Date().toISOString()}] ${message}`);
}

// Configuration
const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface PendingPR {
  id: number;
  pr_url: string;
  org: string;
  repo: string;
  pr_number: number;
}

interface PRStatusResult {
  pr_url: string;
  is_open: boolean;
  has_reviews: boolean;
  error?: string;
}

/**
 * Extract hostname from a PR URL
 */
function extractHostname(prUrl: string): string | null {
  const match = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)/);
  return match ? match[1] : null;
}

/**
 * Fetch pending PRs from Heroku API
 */
async function fetchPendingPRs(): Promise<PendingPR[]> {
  const response = await axios.get(`${HEROKU_API_URL}/api/pending-prs`, {
    headers: {
      'X-Worker-API-Key': WORKER_API_KEY,
    },
    timeout: 30000,
  });
  return response.data.prs || [];
}

/**
 * Check PR status from GitHub Enterprise
 */
async function checkPRStatus(pr: PendingPR): Promise<PRStatusResult> {
  const hostname = extractHostname(pr.pr_url);
  
  if (!hostname) {
    return {
      pr_url: pr.pr_url,
      is_open: true,
      has_reviews: false,
      error: 'Could not extract hostname',
    };
  }

  const baseURL = `https://${hostname}/api/v3`;
  const token = requireTokenForHost(hostname);
  const headers = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github.v3+json',
  };

  try {
    // Get PR details
    const prResponse = await axios.get(
      `${baseURL}/repos/${pr.org}/${pr.repo}/pulls/${pr.pr_number}`,
      { headers, timeout: 10000 }
    );

    const isOpen = prResponse.data.state === 'open' && !prResponse.data.merged;
    const prAuthor: string = prResponse.data.user?.login || '';

    // Get reviews (exclude author's own reviews)
    let hasReviews = false;
    if (isOpen) {
      const reviewsResponse = await axios.get(
        `${baseURL}/repos/${pr.org}/${pr.repo}/pulls/${pr.pr_number}/reviews`,
        { headers, timeout: 10000 }
      );

      const externalReviews = (reviewsResponse.data || []).filter(
        (r: any) => r.state !== 'PENDING' && r.user?.login !== prAuthor,
      );
      hasReviews = externalReviews.length > 0;
    }

    return {
      pr_url: pr.pr_url,
      is_open: isOpen,
      has_reviews: hasReviews,
    };
  } catch (error: any) {
    logError(`  Error checking ${pr.pr_url}: ${error.message}`);
    return {
      pr_url: pr.pr_url,
      is_open: true,
      has_reviews: false,
      error: error.message,
    };
  }
}

/**
 * Report PR status back to Heroku
 */
async function reportStatus(results: PRStatusResult[]): Promise<number> {
  const validResults = results.filter(r => !r.error);
  
  if (validResults.length === 0) {
    return 0;
  }

  const response = await axios.post(
    `${HEROKU_API_URL}/api/pr-status`,
    { results: validResults },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Worker-API-Key': WORKER_API_KEY,
      },
      timeout: 30000,
    }
  );

  return response.data.updated || 0;
}

/**
 * Main worker function
 */
async function runWorker(): Promise<void> {
  log(`${'='.repeat(50)}`);
  log(`PR Status Worker starting...`);
  log(`${'='.repeat(50)}`);

  // Validate configuration
  if (!HEROKU_API_URL) {
    logError('ERROR: HEROKU_API_URL environment variable is required');
    logError('Example: HEROKU_API_URL=https://pr-manager.herokuapp.com');
    process.exit(1);
  }

  if (!WORKER_API_KEY) {
    logError('ERROR: WORKER_API_KEY environment variable is required');
    process.exit(1);
  }

  if (!process.env.GHE_TOKEN && !process.env.GHE_TOKENS) {
    logError('ERROR: GHE_TOKEN or GHE_TOKENS environment variable is required');
    process.exit(1);
  }

  try {
    // Fetch pending PRs from Heroku
    log(`Fetching pending PRs from ${HEROKU_API_URL}...`);
    const pendingPRs = await fetchPendingPRs();
    log(`Found ${pendingPRs.length} PRs to check`);

    if (pendingPRs.length === 0) {
      log('No PRs need status checking. Done!');
      return;
    }

    // Check each PR
    log('Checking PR status from GitHub Enterprise...');
    const results: PRStatusResult[] = [];
    
    for (const pr of pendingPRs) {
      log(`  Checking ${pr.org}/${pr.repo}#${pr.pr_number}...`);
      const result = await checkPRStatus(pr);
      results.push(result);
      
      if (result.error) {
        logError(`    ERROR: ${result.error}`);
      } else {
        log(`    is_open: ${result.is_open}, has_reviews: ${result.has_reviews}`);
      }
      
      // Small delay between API calls
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Report status back to Heroku
    log('Reporting status to Heroku...');
    const updated = await reportStatus(results);
    log(`Updated ${updated} PRs`);

    log('Worker completed successfully!');
  } catch (error: any) {
    logError(`Worker error: ${error.message}`);
    if (error.response) {
      logError(`Response status: ${error.response.status}`);
      logError(`Response data: ${JSON.stringify(error.response.data)}`);
    }
    process.exit(1);
  }
}

/**
 * Run in watch mode (continuously every 5 minutes)
 */
async function runWatchMode(): Promise<void> {
  log('Starting worker in watch mode (every 5 minutes)...');
  log('Press Ctrl+C to stop.');

  // Run immediately
  await runWorker();

  // Then run every 5 minutes
  setInterval(async () => {
    try {
      await runWorker();
    } catch (error) {
      logError(`Worker run failed: ${error}`);
    }
  }, POLL_INTERVAL_MS);
}

// Check if running in watch mode
const isWatchMode = process.argv.includes('--watch') || process.argv.includes('-w');

if (isWatchMode) {
  runWatchMode();
} else {
  runWorker().then(() => {
    process.exit(0);
  }).catch((error) => {
    logError(`Fatal error: ${error}`);
    process.exit(1);
  });
}
