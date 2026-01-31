"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Scheduled job to check for PRs that need review reminders
 * Run this via Heroku Scheduler every 10-15 minutes
 */
require("dotenv/config");
const bolt_1 = require("@slack/bolt");
const reminder_1 = require("../src/services/reminder");
const client_1 = require("../src/db/client");
async function main() {
    console.log('Starting scheduled reminder check...');
    console.log(`Time: ${new Date().toISOString()}`);
    // Validate required environment variables
    const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'GHE_TOKEN', 'DATABASE_URL'];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        process.exit(1);
    }
    // Create a minimal Slack app instance for posting messages
    // We don't need socket mode for the scheduled job
    const app = new bolt_1.App({
        token: process.env.SLACK_BOT_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        // No socketMode - this is a one-shot job
    });
    try {
        await (0, reminder_1.processPendingReminders)(app);
        console.log('Reminder check completed successfully');
    }
    catch (error) {
        console.error('Error during reminder check:', error);
        process.exit(1);
    }
    finally {
        // Close database connection
        await client_1.pool.end();
    }
}
main().catch((error) => {
    console.error('Unexpected error:', error);
    process.exit(1);
});
//# sourceMappingURL=checkReminders.js.map