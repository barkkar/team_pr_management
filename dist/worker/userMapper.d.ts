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
//# sourceMappingURL=userMapper.d.ts.map