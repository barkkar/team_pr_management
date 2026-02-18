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
 *   GHE_TOKEN         - GitHub Enterprise personal access token
 */
import 'dotenv/config';
//# sourceMappingURL=localPRChecker.d.ts.map