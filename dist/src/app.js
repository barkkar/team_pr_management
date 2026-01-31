"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const bolt_1 = require("@slack/bolt");
const prTracker_1 = require("./services/prTracker");
const prParser_1 = require("./utils/prParser");
function createApp() {
    const app = new bolt_1.App({
        token: process.env.SLACK_BOT_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        socketMode: true,
        appToken: process.env.SLACK_APP_TOKEN,
        logLevel: process.env.NODE_ENV === 'production' ? bolt_1.LogLevel.INFO : bolt_1.LogLevel.DEBUG,
    });
    // Listen for messages in channels
    app.message(async ({ message, say }) => {
        // Only process regular messages (not edits, deletes, etc.)
        if (message.subtype) {
            return;
        }
        // Type guard for message with text
        if (!('text' in message) || !message.text) {
            return;
        }
        const text = message.text;
        const channelId = message.channel;
        const messageTs = message.ts;
        // Quick check if message contains a PR link
        if (!(0, prParser_1.containsPRLink)(text)) {
            return;
        }
        console.log(`Detected PR link in channel ${channelId}`);
        // Parse timestamp to Date
        const postedAt = new Date(parseFloat(messageTs) * 1000);
        try {
            const result = await (0, prTracker_1.trackPRsFromMessage)(text, channelId, messageTs, postedAt);
            if (result.tracked.length > 0) {
                console.log(`Tracked ${result.tracked.length} new PR(s) from message`);
            }
        }
        catch (error) {
            console.error('Error tracking PRs from message:', error);
        }
    });
    // Handle app_home_opened event (optional - for app home tab)
    app.event('app_home_opened', async ({ event, client }) => {
        try {
            await client.views.publish({
                user_id: event.user,
                view: {
                    type: 'home',
                    blocks: [
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: '*Welcome to PR Review Reminder Bot!* 👋',
                            },
                        },
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: 'I monitor channels for GitHub Enterprise PR links and send reminders when PRs haven\'t received reviews.',
                            },
                        },
                        {
                            type: 'divider',
                        },
                        {
                            type: 'section',
                            text: {
                                type: 'mrkdwn',
                                text: '*How it works:*\n• Add me to channels where your team posts PR links\n• I\'ll track PRs from `git.soma.salesforce.com`\n• After 2 hours without reviews, I\'ll post a reminder\n• PRs posted after 4 PM PST wait until 10 AM next day',
                            },
                        },
                    ],
                },
            });
        }
        catch (error) {
            console.error('Error publishing home view:', error);
        }
    });
    return app;
}
//# sourceMappingURL=app.js.map