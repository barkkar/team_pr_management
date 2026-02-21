#!/usr/bin/env npx ts-node
"use strict";
/**
 * PR History Harvester
 *
 * Fetches closed/merged PRs from all repos that have appeared in tracked_prs.
 * For each PR: fetches review comments, changed files, and patch diffs via GHE API.
 * Stores results via Heroku API endpoints.
 *
 * Usage:
 *   npm run harvest                  # Full harvest
 *   npm run harvest:incremental      # Only new PRs since last run
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const axios_1 = __importDefault(require("axios"));
const gheTokenResolver_1 = require("../src/utils/gheTokenResolver");
const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const isIncremental = process.argv.includes('--incremental');
function log(message) {
    console.log(`[${new Date().toISOString()}] [PRHarvester] ${message}`);
}
function logError(message) {
    console.error(`[${new Date().toISOString()}] [PRHarvester] ${message}`);
}
function herokuHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-Worker-API-Key': WORKER_API_KEY,
    };
}
function extractHostname(prUrl) {
    const match = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)/);
    return match ? match[1] : null;
}
// ---------------------------------------------------------------------------
// GHE API helpers
// ---------------------------------------------------------------------------
async function fetchClosedPRs(hostname, org, repo, page = 1, perPage = 30) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls`, {
        params: { state: 'closed', sort: 'updated', direction: 'desc', page, per_page: perPage },
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
        },
        timeout: 30000,
    });
    return response.data || [];
}
async function fetchPRReviewComments(hostname, org, repo, prNumber) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    // Pull request review comments (inline comments on diff)
    const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/comments`, {
        params: { per_page: 100 },
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
        },
        timeout: 30000,
    });
    return response.data || [];
}
async function fetchPRReviews(hostname, org, repo, prNumber) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/reviews`, {
        params: { per_page: 100 },
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
        },
        timeout: 30000,
    });
    return response.data || [];
}
async function fetchPRFiles(hostname, org, repo, prNumber) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}/files`, {
        params: { per_page: 100 },
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
        },
        timeout: 30000,
    });
    return response.data || [];
}
// ---------------------------------------------------------------------------
// Heroku API helpers
// ---------------------------------------------------------------------------
async function fetchDistinctRepos() {
    const response = await axios_1.default.get(`${HEROKU_API_URL}/api/distinct-repos`, {
        headers: { 'X-Worker-API-Key': WORKER_API_KEY },
        timeout: 30000,
    });
    return response.data.repos || [];
}
async function fetchHarvestState(org, repo) {
    try {
        const response = await axios_1.default.get(`${HEROKU_API_URL}/api/harvest-state`, {
            params: { org, repo },
            headers: { 'X-Worker-API-Key': WORKER_API_KEY },
            timeout: 30000,
        });
        return response.data.state || null;
    }
    catch {
        return null;
    }
}
async function reportHarvestData(data) {
    await axios_1.default.post(`${HEROKU_API_URL}/api/harvest-data`, data, {
        headers: herokuHeaders(),
        timeout: 60000,
    });
}
// ---------------------------------------------------------------------------
// Main harvest logic
// ---------------------------------------------------------------------------
async function harvestRepo(hostname, org, repo) {
    log(`Harvesting ${org}/${repo} from ${hostname}...`);
    let lastHarvestedPR = 0;
    if (isIncremental) {
        const state = await fetchHarvestState(org, repo);
        lastHarvestedPR = state?.last_harvested_pr_number || 0;
        log(`  Incremental mode: starting after PR #${lastHarvestedPR}`);
    }
    let page = 1;
    let totalReviews = 0;
    let totalFiles = 0;
    let highestPR = lastHarvestedPR;
    let hasMore = true;
    while (hasMore) {
        const closedPRs = await fetchClosedPRs(hostname, org, repo, page, 30);
        if (closedPRs.length === 0)
            break;
        const batchReviews = [];
        const batchFiles = [];
        for (const pr of closedPRs) {
            const prNumber = pr.number;
            const prUrl = pr.html_url;
            const prAuthor = pr.user?.login || '';
            // In incremental mode, skip already-harvested PRs
            if (isIncremental && prNumber <= lastHarvestedPR) {
                hasMore = false;
                break;
            }
            if (prNumber > highestPR)
                highestPR = prNumber;
            log(`  Processing PR #${prNumber}: ${pr.title}`);
            // Fetch review comments (inline diff comments)
            try {
                const comments = await fetchPRReviewComments(hostname, org, repo, prNumber);
                for (const comment of comments) {
                    batchReviews.push({
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
            }
            catch (error) {
                logError(`    Failed to fetch review comments for PR #${prNumber}: ${error.message}`);
            }
            // Fetch top-level reviews (APPROVED, CHANGES_REQUESTED, etc.)
            try {
                const reviews = await fetchPRReviews(hostname, org, repo, prNumber);
                for (const review of reviews) {
                    if (review.body && review.body.trim().length > 0) {
                        batchReviews.push({
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
            }
            catch (error) {
                logError(`    Failed to fetch reviews for PR #${prNumber}: ${error.message}`);
            }
            // Fetch changed files
            try {
                const files = await fetchPRFiles(hostname, org, repo, prNumber);
                for (const file of files) {
                    batchFiles.push({
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
            }
            catch (error) {
                logError(`    Failed to fetch files for PR #${prNumber}: ${error.message}`);
            }
            // Rate limit
            await new Promise(resolve => setTimeout(resolve, 300));
        }
        // Report batch to Heroku
        if (batchReviews.length > 0 || batchFiles.length > 0) {
            try {
                await reportHarvestData({
                    reviews: batchReviews,
                    files: batchFiles,
                    harvest_state: { org, repo, last_pr_number: highestPR },
                });
                totalReviews += batchReviews.length;
                totalFiles += batchFiles.length;
                log(`  Reported ${batchReviews.length} reviews, ${batchFiles.length} files`);
            }
            catch (error) {
                logError(`  Failed to report harvest data: ${error.message}`);
            }
        }
        page++;
        // Stop after 10 pages (300 PRs) for safety in full mode
        if (!isIncremental && page > 10) {
            log(`  Reached page limit (10). Use incremental mode for ongoing harvesting.`);
            break;
        }
    }
    log(`  Done: ${totalReviews} reviews, ${totalFiles} files harvested from ${org}/${repo}`);
}
async function run() {
    log('='.repeat(60));
    log(`PR History Harvester starting (${isIncremental ? 'incremental' : 'full'} mode)...`);
    log('='.repeat(60));
    if (!HEROKU_API_URL || !WORKER_API_KEY) {
        logError('HEROKU_API_URL and WORKER_API_KEY are required');
        process.exit(1);
    }
    if (!process.env.GHE_TOKEN && !process.env.GHE_TOKENS) {
        logError('GHE_TOKEN or GHE_TOKENS is required');
        process.exit(1);
    }
    // Get repos from tracked PRs
    let repos;
    try {
        repos = await fetchDistinctRepos();
        log(`Found ${repos.length} repo(s) to harvest`);
    }
    catch (error) {
        logError(`Failed to fetch repos: ${error.message}`);
        process.exit(1);
        return;
    }
    for (const { org, repo, hostname } of repos) {
        try {
            await harvestRepo(hostname, org, repo);
        }
        catch (error) {
            logError(`Failed to harvest ${org}/${repo}: ${error.message}`);
        }
    }
    log('Harvest complete!');
}
run().then(() => process.exit(0)).catch((error) => {
    logError(`Fatal error: ${error}`);
    process.exit(1);
});
//# sourceMappingURL=prHarvester.js.map