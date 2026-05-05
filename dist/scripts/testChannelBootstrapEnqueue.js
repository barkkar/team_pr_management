#!/usr/bin/env npx ts-node
"use strict";
/**
 * Test script: enqueue a Slack channel's members for bootstrap and print the
 * resulting rows from `channel_bootstrap_members`.
 *
 * Usage: npx ts-node scripts/testChannelBootstrapEnqueue.ts <channel-id>
 */
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const web_api_1 = require("@slack/web-api");
const channelBootstrap_1 = require("../src/services/channelBootstrap");
const client_1 = require("../src/db/client");
async function main() {
    const channelId = process.argv[2];
    if (!channelId) {
        console.error('Usage: npx ts-node scripts/testChannelBootstrapEnqueue.ts <channel-id>');
        process.exit(1);
    }
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
        console.error('SLACK_BOT_TOKEN is not set in the environment.');
        process.exit(1);
    }
    const slackClient = new web_api_1.WebClient(token);
    const { queued } = await (0, channelBootstrap_1.enqueueChannelBootstrap)(channelId, slackClient);
    console.log(`Enqueued ${queued} new row(s).`);
    const result = await client_1.pool.query(`SELECT id, slack_user_id, email, status, enqueued_at
     FROM channel_bootstrap_members
     WHERE channel_id = $1
     ORDER BY enqueued_at DESC
     LIMIT 50`, [channelId]);
    if (result.rows.length === 0) {
        console.log('(no rows)');
    }
    else {
        for (const row of result.rows) {
            console.log(`id=${row.id} slack_user_id=${row.slack_user_id} email=${row.email} status=${row.status} enqueued_at=${row.enqueued_at.toISOString()}`);
        }
    }
    await client_1.pool.end();
}
main().catch(async (err) => {
    console.error(err);
    await client_1.pool.end();
    process.exit(1);
});
//# sourceMappingURL=testChannelBootstrapEnqueue.js.map