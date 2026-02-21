#!/usr/bin/env npx ts-node
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
import 'dotenv/config';
//# sourceMappingURL=prHarvester.d.ts.map