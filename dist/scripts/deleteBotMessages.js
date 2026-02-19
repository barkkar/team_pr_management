#!/usr/bin/env npx ts-node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * One-off script to delete reminder messages posted by the bot in a Slack channel.
 *
 * Usage:
 *   CHANNEL_ID=C0123ABC npm run delete-bot-messages
 *   or
 *   npx ts-node scripts/deleteBotMessages.ts C0123ABC
 *
 * To get the channel ID: Right-click the channel in Slack -> View channel details -> copy from URL
 * Or: the channel ID is in the URL when you open the channel (e.g. slack.com/archives/C0123ABC)
 */
require("dotenv/config");
const web_api_1 = require("@slack/web-api");
const CHANNEL_ID = process.env.CHANNEL_ID || process.argv[2];
async function main() {
    if (!CHANNEL_ID) {
        console.error('Usage: CHANNEL_ID=C0123ABC npm run delete-bot-messages');
        console.error('   or: npx ts-node scripts/deleteBotMessages.ts C0123ABC');
        process.exit(1);
    }
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
        console.error('SLACK_BOT_TOKEN is required');
        process.exit(1);
    }
    const client = new web_api_1.WebClient(token);
    // Get bot's user ID
    const auth = await client.auth.test();
    const botUserId = auth.user_id;
    console.log(`Bot user ID: ${botUserId}`);
    console.log(`Fetching messages from channel ${CHANNEL_ID}...`);
    let cursor;
    let deleted = 0;
    do {
        const result = await client.conversations.history({
            channel: CHANNEL_ID,
            limit: 100,
            cursor,
        });
        const messages = result.messages || [];
        for (const msg of messages) {
            // Match messages from our bot (by user ID or by reminder text)
            const isFromBot = msg.user === botUserId || msg.bot_id;
            const isReminder = msg.text?.includes('Reminder: This PR has been waiting') ||
                msg.text?.includes('PR Review Reminder');
            if ((isFromBot || isReminder) && msg.ts) {
                try {
                    await client.chat.delete({ channel: CHANNEL_ID, ts: msg.ts });
                    deleted++;
                    console.log(`  Deleted message ${msg.ts}`);
                }
                catch (err) {
                    if (err?.data?.error === 'message_not_found') {
                        console.log(`  Skipped (already deleted): ${msg.ts}`);
                    }
                    else {
                        console.error(`  Failed to delete ${msg.ts}:`, err?.data?.error || err.message);
                    }
                }
                await new Promise(r => setTimeout(r, 200)); // Rate limit
            }
        }
        cursor = result.response_metadata?.next_cursor;
    } while (cursor);
    console.log(`\nDone. Deleted ${deleted} message(s).`);
}
main().catch(err => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=deleteBotMessages.js.map