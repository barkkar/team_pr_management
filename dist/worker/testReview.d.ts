#!/usr/bin/env npx ts-node
/**
 * Test Review (dry-run)
 *
 * Runs the full AI review pipeline for a given PR URL and logs results
 * to the console. Nothing is saved to the database or posted to Slack.
 *
 * Usage:
 *   npm run test-review -- https://git.soma.salesforce.com/org/repo/pull/123
 *   npm run test-review -- https://... --no-mention          # suppress reviewer @mentions
 *   npm run test-review -- https://... --post --channel=C123  # post to Slack
 *   npm run test-review -- https://... --post --channel=C123 --no-mention
 */
import 'dotenv/config';
//# sourceMappingURL=testReview.d.ts.map