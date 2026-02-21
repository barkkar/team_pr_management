#!/usr/bin/env npx ts-node
"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const axios_1 = __importDefault(require("axios"));
const gheTokenResolver_1 = require("../src/utils/gheTokenResolver");
const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const harvestAll = process.env.HARVEST_ALL === '1';
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
async function fetchPRDetails(hostname, org, repo, prNumber) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/pulls/${prNumber}`, {
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
        },
        timeout: 15000,
    });
    return response.data;
}
async function fetchPRReviewComments(hostname, org, repo, prNumber) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
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
async function fetchTrackedPRs() {
    const endpoint = harvestAll ? '/api/all-tracked-prs' : '/api/tracked-prs-for-harvest';
    const response = await axios_1.default.get(`${HEROKU_API_URL}${endpoint}`, {
        headers: { 'X-Worker-API-Key': WORKER_API_KEY },
        timeout: 30000,
    });
    return response.data.prs || [];
}
async function reportHarvestData(data) {
    await axios_1.default.post(`${HEROKU_API_URL}/api/harvest-data`, data, {
        headers: herokuHeaders(),
        timeout: 60000,
    });
}
// ---------------------------------------------------------------------------
// Harvest a single PR
// ---------------------------------------------------------------------------
async function harvestPR(pr) {
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
    }
    catch (error) {
        log(`  PR #${prNumber}: could not fetch details (${error.message}), continuing...`);
    }
    const reviews = [];
    const files = [];
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
    }
    catch (error) {
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
    }
    catch (error) {
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
    }
    catch (error) {
        logError(`    Failed to fetch files: ${error.message}`);
    }
    // Report to Heroku
    if (reviews.length > 0 || files.length > 0) {
        try {
            await reportHarvestData({ reviews, files });
        }
        catch (error) {
            logError(`    Failed to report harvest data: ${error.message}`);
        }
    }
    return { reviews: reviews.length, files: files.length };
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
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
    let prs;
    try {
        prs = await fetchTrackedPRs();
        log(`Found ${prs.length} PR(s) to harvest`);
    }
    catch (error) {
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
        }
        catch (error) {
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
//# sourceMappingURL=prHarvester.js.map