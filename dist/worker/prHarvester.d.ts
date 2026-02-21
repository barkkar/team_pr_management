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
//# sourceMappingURL=prHarvester.d.ts.map