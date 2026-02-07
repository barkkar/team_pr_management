"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.socketModeStats = void 0;
exports.createApp = createApp;
const bolt_1 = require("@slack/bolt");
const prTracker_1 = require("./services/prTracker");
const prParser_1 = require("./utils/prParser");
const client_1 = require("./db/client");
// Socket Mode statistics (exported for status command)
exports.socketModeStats = {
    messagesReceived: 0,
    prsTracked: 0,
    lastMessageAt: null,
    startedAt: new Date(),
};
function createApp() {
    const app = new bolt_1.App({
        token: process.env.SLACK_BOT_TOKEN,
        signingSecret: process.env.SLACK_SIGNING_SECRET,
        socketMode: true,
        appToken: process.env.SLACK_APP_TOKEN,
        logLevel: bolt_1.LogLevel.INFO, // Reduced from DEBUG to INFO
    });
    // Log all incoming events via Socket Mode
    app.use(async ({ payload, next }) => {
        const eventType = payload.type || 'unknown';
        if (eventType === 'message') {
            exports.socketModeStats.messagesReceived++;
            exports.socketModeStats.lastMessageAt = new Date();
        }
        console.log(`[Socket Mode] Received event: ${eventType}`);
        await next();
    });
    // Listen for messages in channels (via Socket Mode - real-time)
    app.message(async ({ message, client }) => {
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
        console.log(`[Socket Mode] PR link detected in channel ${channelId}`);
        // Parse timestamp to Date
        const postedAt = new Date(parseFloat(messageTs) * 1000);
        try {
            const result = await (0, prTracker_1.trackPRsFromMessage)(text, channelId, messageTs, postedAt);
            if (result.tracked.length > 0) {
                exports.socketModeStats.prsTracked += result.tracked.length;
                console.log(`[Socket Mode] Tracked ${result.tracked.length} new PR(s)`);
                // Add robot_face reaction to acknowledge the PR has been noticed
                try {
                    await client.reactions.add({
                        channel: channelId,
                        timestamp: messageTs,
                        name: 'robot_face',
                    });
                }
                catch (reactionError) {
                    // Ignore if reaction already exists
                    if (reactionError?.data?.error !== 'already_reacted') {
                        console.log('[Socket Mode] Could not add reaction:', reactionError?.data?.error || reactionError);
                    }
                }
            }
            else if (result.skipped.length > 0) {
                console.log(`[Socket Mode] Skipped ${result.skipped.length} PR(s) (already tracked)`);
            }
        }
        catch (error) {
            console.error('[Socket Mode] Error tracking PRs:', error);
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
                    // Calculate uptime
                    const uptimeMs = Date.now() - exports.socketModeStats.startedAt.getTime();
                    const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60));
                    const uptimeMinutes = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));
                    const uptimeStr = uptimeHours > 0 ? `${uptimeHours}h ${uptimeMinutes}m` : `${uptimeMinutes}m`;
                    // Format last message time
                    const lastMsgStr = exports.socketModeStats.lastMessageAt
                        ? `${Math.round((Date.now() - exports.socketModeStats.lastMessageAt.getTime()) / 1000)}s ago`
                        : 'never';
                    await respond({
                        text: `*PR Monitor Status*\n\n` +
                            `*Channel:*\n` +
                            `• This channel: ${isMonitored ? '✅ Monitored' : '❌ Not monitored'}\n` +
                            `• Total monitored channels: ${channels.length}\n` +
                            `• PRs awaiting review: ${pendingPRs.length}\n\n` +
                            `*Socket Mode (Real-time):*\n` +
                            `• Uptime: ${uptimeStr}\n` +
                            `• Messages received: ${exports.socketModeStats.messagesReceived}\n` +
                            `• PRs tracked via Socket Mode: ${exports.socketModeStats.prsTracked}\n` +
                            `• Last message: ${lastMsgStr}\n\n` +
                            `_Polling runs every 10 min as backup. Use \`/pr-monitor help\` for commands._`,
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