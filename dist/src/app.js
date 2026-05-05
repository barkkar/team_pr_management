"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.socketModeStats = void 0;
exports.createApp = createApp;
const bolt_1 = require("@slack/bolt");
const prTracker_1 = require("./services/prTracker");
const prParser_1 = require("./utils/prParser");
const client_1 = require("./db/client");
const errorNotifier_1 = require("./utils/errorNotifier");
const channelAccessControl_1 = require("./services/channelAccessControl");
const channelBootstrap_1 = require("./services/channelBootstrap");
function formatWaitTime(postedAt) {
    const waitMs = Date.now() - new Date(postedAt).getTime();
    const days = Math.floor(waitMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor((waitMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((waitMs % (1000 * 60 * 60)) / (1000 * 60));
    if (days > 0)
        return `${days}d ${hours}h`;
    if (hours > 0)
        return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}
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
        // --- Channel allowlist enforcement (groups:history / channels:history) ---
        if (!(0, channelAccessControl_1.isChannelAllowed)(channelId)) {
            console.warn(`[Socket Mode] BLOCKED: Received message from non-allowlisted channel ${channelId}. ` +
                `Ignoring per channel access control policy.`);
            return;
        }
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
            (0, errorNotifier_1.notifyError)('SocketMode', `Error tracking PRs: ${error.message || error}`);
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
                    // --- Channel allowlist enforcement ---
                    if (!(0, channelAccessControl_1.isChannelAllowed)(channelId)) {
                        console.warn(`[Slash Command] BLOCKED: /pr-monitor add attempted in non-allowlisted channel ${channelId} by user ${userId}`);
                        await respond({
                            text: `❌ This channel (${channelId}) is not in the approved channel allowlist. ` +
                                `The bot can only monitor channels that have been explicitly allowlisted. ` +
                                `Please contact your Slack workspace admin to add this channel to the ALLOWED_CHANNEL_IDS configuration.`,
                        });
                        break;
                    }
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
                    // Unified reply — no branching on `added`. See spec §5.1 step 5.
                    await respond({
                        response_type: 'in_channel',
                        text: '✅ This channel is now being monitored for PR review requests. ' +
                            "Queuing members for reviewer mapping — I'll follow up here with the count.",
                    });
                    // setImmediate lets the slash-command ack return <1s. Bolt's `respond`
                    // closure wraps Slack's signed `response_url`, which is valid for 30 min
                    // and 5 follow-ups — ample for a single delayed reply.
                    //
                    // SAFETY: the outer try/catch is MANDATORY. Any throw that escapes a
                    // setImmediate callback is uncaught at the Bolt layer and would crash
                    // the dyno process. Do not remove it.
                    setImmediate(async () => {
                        try {
                            const { queued } = await (0, channelBootstrap_1.enqueueChannelBootstrap)(channelId, client);
                            await respond({
                                response_type: 'ephemeral',
                                replace_original: false,
                                text: `Queued ${queued} member(s) for reviewer mapping.`,
                            });
                        }
                        catch (err) {
                            // Distinguish scope failures (non-retryable, operator action needed)
                            // from transient Slack/DB blips (retryable on next /pr-monitor add).
                            const isScopeError = err?.data?.error === 'missing_scope' ||
                                /missing_scope|not_in_channel|not_authed/.test(String(err?.message || ''));
                            const userMessage = isScopeError
                                ? 'Member bootstrap skipped — Slack bot is missing required scope. Contact the workspace admin.'
                                : 'Member bootstrap failed — will retry when members post PRs.';
                            try {
                                await respond({
                                    response_type: 'ephemeral',
                                    replace_original: false,
                                    text: userMessage,
                                });
                            }
                            catch (_respondErr) {
                                // response_url may have expired; fall through to notifyError below.
                            }
                            (0, errorNotifier_1.notifyError)('ChannelBootstrap', `enqueueChannelBootstrap failed for ${channelId}: ${err.message}`, isScopeError ? 'error' : 'warn');
                        }
                    });
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
                case 'pending': {
                    const pendingList = await (0, client_1.getOpenUnreviewedPRs)();
                    if (pendingList.length === 0) {
                        await respond({
                            text: `No PRs are currently awaiting review.`,
                        });
                    }
                    else {
                        const prLines = pendingList.map(pr => {
                            const waitStr = formatWaitTime(pr.posted_at);
                            const count = pr.reminder_count || 0;
                            const reminderStr = count === 0 ? 'no reminders sent' : `${count} reminder${count !== 1 ? 's' : ''} sent`;
                            return `• <${pr.pr_url}|${pr.org}/${pr.repo}#${pr.pr_number}> — posted in <#${pr.channel_id}> — waiting *${waitStr}* — ${reminderStr}`;
                        }).join('\n');
                        await respond({
                            text: `*PRs Awaiting Review (${pendingList.length}):*\n\n${prLines}`,
                        });
                    }
                    break;
                }
                case 'status': {
                    const channels = await (0, client_1.getMonitoredChannels)();
                    const pendingPRs = await (0, client_1.getOpenUnreviewedPRs)();
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
                    const allowedIds = (0, channelAccessControl_1.getAllowedChannelIds)();
                    const isAllowed = (0, channelAccessControl_1.isChannelAllowed)(channelId);
                    await respond({
                        text: `*PR Monitor Status*\n\n` +
                            `*Channel:*\n` +
                            `• This channel: ${isMonitored ? '✅ Monitored' : '❌ Not monitored'}\n` +
                            `• Allowlisted: ${isAllowed ? '✅ Yes' : '❌ No'}\n` +
                            `• Total monitored channels: ${channels.length}\n` +
                            `• PRs awaiting review: ${pendingPRs.length}${pendingPRs.length > 0 ? ` (oldest: ${formatWaitTime(pendingPRs[0].posted_at)}) — use \`/pr-monitor pending\` for details` : ''}\n\n` +
                            `*Channel Access Control:*\n` +
                            `• Allowlisted channels: ${allowedIds.length}\n` +
                            `• IDs: ${allowedIds.map(id => `\`${id}\``).join(', ')}\n\n` +
                            `*Socket Mode (Real-time):*\n` +
                            `• Uptime: ${uptimeStr}\n` +
                            `• Messages received: ${exports.socketModeStats.messagesReceived}\n` +
                            `• PRs tracked via Socket Mode: ${exports.socketModeStats.prsTracked}\n` +
                            `• Last message: ${lastMsgStr}\n\n` +
                            `_Polling runs every 10 min as backup. Use \`/pr-monitor help\` for commands._`,
                    });
                    break;
                }
                case 'stats': {
                    const stats = await (0, client_1.getReviewStats)();
                    const pct = (n) => stats.totalTracked > 0 ? `(${Math.round((n / stats.totalTracked) * 100)}%)` : '';
                    const breakdownLines = stats.reminderBreakdown.map(b => `• ${b.reminders} reminder${b.reminders !== '1' ? 's' : ''}: ${b.count}`).join('\n');
                    await respond({
                        text: `*PR Review Statistics:*\n\n` +
                            `*Summary:*\n` +
                            `• Total PRs tracked: ${stats.totalTracked}\n` +
                            `• Reviewed without reminders: ${stats.reviewedWithoutReminders} ${pct(stats.reviewedWithoutReminders)}\n` +
                            `• Reviewed after reminders: ${stats.reviewedAfterReminders} ${pct(stats.reviewedAfterReminders)}\n` +
                            `• Still awaiting review: ${stats.stillAwaiting} ${pct(stats.stillAwaiting)}\n` +
                            `• Closed/merged: ${stats.closed} ${pct(stats.closed)}\n\n` +
                            `*Reminders per PR:*\n` +
                            `${breakdownLines}\n` +
                            `• Average reminders before review: ${stats.avgRemindersBeforeReview}`,
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
                            `• \`/pr-monitor pending\` - Show PRs awaiting review with wait times\n` +
                            `• \`/pr-monitor stats\` - Show review statistics and reminder counts\n` +
                            `• \`/pr-monitor status\` - Show current status\n` +
                            `• \`/pr-monitor help\` - Show this help message`,
                    });
                    break;
                }
            }
        }
        catch (error) {
            console.error('Error handling /pr-monitor command:', error);
            (0, errorNotifier_1.notifyError)('SlackCommand', `Error handling /pr-monitor: ${error.message || error}`);
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
            (0, errorNotifier_1.notifyError)('SlackApp', `Error publishing home view: ${error.message || error}`, 'warn');
        }
    });
    app.event('member_joined_channel', async ({ event, client }) => {
        try {
            const { channel: channelId, user: userId } = event;
            if (!channelId || !userId)
                return;
            // Respect the same allowlist + monitored-channels gates as the rest of the app.
            if (!(0, channelAccessControl_1.isChannelAllowed)(channelId))
                return;
            if (!(await (0, client_1.isChannelMonitored)(channelId)))
                return;
            const info = await client.users.info({ user: userId });
            const u = info.user;
            if (!u || u.is_bot || u.deleted)
                return;
            const email = u.profile?.email;
            if (!email)
                return;
            await (0, client_1.insertBootstrapMembers)([{ channel_id: channelId, slack_user_id: userId, email }]);
        }
        catch (err) {
            (0, errorNotifier_1.notifyError)('ChannelBootstrap', `member_joined_channel handler failed: ${err?.message || String(err)}`, 'warn');
        }
    });
    return app;
}
//# sourceMappingURL=app.js.map