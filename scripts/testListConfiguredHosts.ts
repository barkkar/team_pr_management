#!/usr/bin/env npx ts-node
/**
 * Test script: prints configured GHE hostnames in search-priority order.
 *
 * Usage: npx ts-node scripts/testListConfiguredHosts.ts
 */

import 'dotenv/config';
import { listConfiguredHosts } from '../src/utils/gheTokenResolver';

const hosts = listConfiguredHosts();
console.log(`Configured GHE hosts (${hosts.length}):`);
for (const host of hosts) {
  console.log(`  - ${host}`);
}
