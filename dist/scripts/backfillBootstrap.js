"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const web_api_1 = require("@slack/web-api");
const client_1 = require("../src/db/client");
const channelBootstrap_1 = require("../src/services/channelBootstrap");
async function main() {
    const required = ['SLACK_BOT_TOKEN', 'DATABASE_URL'];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
        console.error(`Missing env: ${missing.join(', ')}`);
        process.exit(1);
    }
    const argChannels = process.argv.slice(2).filter((a) => a.startsWith('C'));
    const slack = new web_api_1.WebClient(process.env.SLACK_BOT_TOKEN);
    let channels;
    if (argChannels.length > 0) {
        channels = argChannels;
    }
    else {
        const result = await client_1.pool.query(`SELECT mc.channel_id
       FROM monitored_channels mc
       LEFT JOIN channel_bootstrap_members cbm ON cbm.channel_id = mc.channel_id
       WHERE mc.enabled = TRUE AND cbm.id IS NULL
       GROUP BY mc.channel_id
       ORDER BY mc.channel_id`);
        channels = result.rows.map((r) => r.channel_id);
    }
    console.log(`Backfilling ${channels.length} channel(s): ${channels.join(', ')}`);
    for (const channelId of channels) {
        try {
            const { queued } = await (0, channelBootstrap_1.enqueueChannelBootstrap)(channelId, slack);
            console.log(`  ${channelId}: queued ${queued} member(s)`);
        }
        catch (err) {
            console.error(`  ${channelId}: FAILED — ${err.message}`);
        }
    }
    await client_1.pool.end();
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=backfillBootstrap.js.map