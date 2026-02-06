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
        logLevel: bolt_1.LogLevel.DEBUG, // Always debug for now
    });
    // Debug: Log all incoming events
    app.use(async ({ payload, next }) => {
        console.log(`[DEBUG] Received event type: ${payload.type || 'unknown'}`);
        await next();
    });
    // Listen for messages in channels
    app.message(async ({ message, client }) => {
        console.log(`[DEBUG] Message received:`, JSON.stringify({
            channel: message.channel,
            subtype: message.subtype,
            hasText: 'text' in message,
            textPreview: ('text' in message && message.text) ? message.text.substring(0, 100) : 'N/A'
        }));
        // Only process regular messages (not edits, deletes, etc.)
        if (message.subtype) {
            console.log(`[DEBUG] Skipping message with subtype: ${message.subtype}`);
            return;
        }
        // Type guard for message with text
        if (!('text' in message) || !message.text) {
            console.log(`[DEBUG] Skipping message without text`);
            return;
        }
        const text = message.text;
        const channelId = message.channel;
        const messageTs = message.ts;
        // Quick check if message contains a PR link
        const hasPRLink = (0, prParser_1.containsPRLink)(text);
        console.log(`[DEBUG] Contains PR link: ${hasPRLink}, text: ${text.substring(0, 100)}`);
        if (!hasPRLink) {
            return;
        }
        console.log(`Detected PR link in channel ${channelId}`);
        // Parse timestamp to Date
        const postedAt = new Date(parseFloat(messageTs) * 1000);
        try {
            const result = await (0, prTracker_1.trackPRsFromMessage)(text, channelId, messageTs, postedAt);
            if (result.tracked.length > 0) {
                console.log(`Tracked ${result.tracked.length} new PR(s) from message`);
                // Add robot_face reaction to acknowledge the PR has been noticed
                try {
                    await client.reactions.add({
                        channel: channelId,
                        timestamp: messageTs,
                        name: 'robot_face',
                    });
                }
                catch (reactionError) {
                    // Ignore if reaction already exists or other minor errors
                    console.log('Could not add reaction:', reactionError);
                }
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