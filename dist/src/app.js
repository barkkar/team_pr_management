"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createApp = createApp;
const bolt_1 = require("@slack/bolt");
const prTracker_1 = require("./services/prTracker");
const prParser_1 = require("./utils/prParser");
const client_1 = require("./db/client");
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
    // Slash command: /pr-monitor
    app.command('/pr-monitor', async ({ command, ack, respond, client }) => {
        await ack();
        const args = command.text.trim().split(/\s+/);
        const subcommand = args[0]?.toLowerCase() || 'help';
        const channelId = command.channel_id;
        const userId = command.user_id;
        try {
            switch (subcommand) {
                case 'add': {
                    // Get channel info for the name
                    let channelName = null;
                    try {
                        const info = await client.conversations.info({ channel: channelId });
                        channelName = info.channel?.name || null;
                    }
                    catch (e) {
                        // Ignore - channel name is optional
                    }
                    const added = await (0, client_1.addMonitoredChannel)(channelId, channelName, userId);
                    if (added) {
                        await respond({
                            response_type: 'in_channel',
                            text: `✅ This channel is now being monitored for PR review requests. I'll track PRs and send reminders when they need reviews.`,
                        });
                    }
                    else {
                        await respond({
                            text: `This channel is already being monitored.`,
                        });
                    }
                    break;
                }
                case 'remove': {
                    const removed = await (0, client_1.removeMonitoredChannel)(channelId);
                    if (removed) {
                        await respond({
                            response_type: 'in_channel',
                            text: `🛑 This channel is no longer being monitored for PR review requests.`,
                        });
                    }
                    else {
                        await respond({
                            text: `This channel was not being monitored.`,
                        });
                    }
                    break;
                }
                case 'list': {
                    const channels = await (0, client_1.getMonitoredChannels)();
                    if (channels.length === 0) {
                        await respond({
                            text: `No channels are currently being monitored.\n\nUse \`/pr-monitor add\` in a channel to start monitoring it.`,
                        });
                    }
                    else {
                        const channelList = channels.map(c => `• <#${c.channel_id}>${c.channel_name ? ` (${c.channel_name})` : ''}`).join('\n');
                        await respond({
                            text: `*Monitored Channels (${channels.length}):*\n${channelList}`,
                        });
                    }
                    break;
                }
                case 'status': {
                    const channels = await (0, client_1.getMonitoredChannels)();
                    const pendingPRs = await (0, client_1.getPendingReminders)();
                    const isMonitored = await (0, client_1.isChannelMonitored)(channelId);
                    await respond({
                        text: `*PR Monitor Status*\n\n` +
                            `• This channel: ${isMonitored ? '✅ Monitored' : '❌ Not monitored'}\n` +
                            `• Total monitored channels: ${channels.length}\n` +
                            `• PRs awaiting review: ${pendingPRs.length}\n\n` +
                            `_Use \`/pr-monitor help\` for available commands._`,
                    });
                    break;
                }
                case 'help':
                default: {
                    await respond({
                        text: `*PR Monitor Commands:*\n\n` +
                            `• \`/pr-monitor add\` - Start monitoring this channel for PRs\n` +
                            `• \`/pr-monitor remove\` - Stop monitoring this channel\n` +
                            `• \`/pr-monitor list\` - Show all monitored channels\n` +
                            `• \`/pr-monitor status\` - Show current status\n` +
                            `• \`/pr-monitor help\` - Show this help message`,
                    });
                    break;
                }
            }
        }
        catch (error) {
            console.error('Error handling /pr-monitor command:', error);
            await respond({
                text: `❌ An error occurred: ${error.message}`,
            });
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