#!/usr/bin/env npx ts-node
"use strict";
/**
 * Test script: prints configured GHE hostnames in search-priority order.
 *
 * Usage: npx ts-node scripts/testListConfiguredHosts.ts
 */
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const gheTokenResolver_1 = require("../src/utils/gheTokenResolver");
const hosts = (0, gheTokenResolver_1.listConfiguredHosts)();
console.log(`Configured GHE hosts (${hosts.length}):`);
for (const host of hosts) {
    console.log(`  - ${host}`);
}
//# sourceMappingURL=testListConfiguredHosts.js.map