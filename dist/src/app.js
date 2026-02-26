"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.socketModeStats = void 0;
exports.createApp = createApp;
const bolt_1 = require("@slack/bolt");
const prTracker_1 = require("./services/prTracker");
const prParser_1 = require("./utils/prParser");
const client_1 = require("./db/client");
const channelAccessControl_1 = require("./services/channelAccessControl");
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
                case 'harvest-status': {
                    // Show AI knowledge base harvest status
                    try {
                        const harvestRows = await client_1.pool.query('SELECT org, repo, last_harvested_pr_number, last_repo_harvest_sha, last_harvested_at, last_repo_harvested_at FROM harvest_state ORDER BY org, repo');
                        const reviewCount = await client_1.pool.query('SELECT COUNT(*) as count FROM pr_reviews');
                        const fileCount = await client_1.pool.query('SELECT COUNT(*) as count FROM pr_files');
                        const embeddingCount = await client_1.pool.query('SELECT COUNT(*) as count FROM pr_embeddings');
                        const repoKnowledgeCount = await client_1.pool.query('SELECT COUNT(*) as count FROM repo_knowledge');
                        const userMappingCount = await client_1.pool.query('SELECT COUNT(*) as count FROM user_mappings');
                        const mappedCount = await client_1.pool.query('SELECT COUNT(*) as count FROM user_mappings WHERE slack_user_id IS NOT NULL');
                        let repoLines = '_No repos harvested yet._';
                        if (harvestRows.rows.length > 0) {
                            repoLines = harvestRows.rows.map((r) => {
                                const prInfo = r.last_harvested_pr_number ? `PR #${r.last_harvested_pr_number}` : 'not started';
                                const repoInfo = r.last_repo_harvest_sha ? `SHA ${r.last_repo_harvest_sha.substring(0, 8)}` : 'not started';
                                return `• \`${r.org}/${r.repo}\` — PRs: ${prInfo}, Code: ${repoInfo}`;
                            }).join('\n');
                        }
                        await respond({
                            text: `*:brain: AI Knowledge Base Status*\n\n` +
                                `*Data:*\n` +
                                `• PR review comments: ${reviewCount.rows[0].count}\n` +
                                `• PR files tracked: ${fileCount.rows[0].count}\n` +
                                `• Embeddings: ${embeddingCount.rows[0].count}\n` +
                                `• Codebase chunks: ${repoKnowledgeCount.rows[0].count}\n` +
                                `• User mappings: ${userMappingCount.rows[0].count} (${mappedCount.rows[0].count} with Slack ID)\n\n` +
                                `*Repos:*\n${repoLines}`,
                        });
                    }
                    catch (harvestError) {
                        await respond({
                            text: `*:brain: AI Knowledge Base Status*\n\n_Tables not yet created. Run migrations first._`,
                        });
                    }
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
                            `• \`/pr-monitor harvest-status\` - Show AI knowledge base harvest status\n` +
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
    // ---------------------------------------------------------------------------
    // AI Review Feedback — button action handlers
    // ---------------------------------------------------------------------------
    app.action('ai_review_helpful', async ({ action, ack, body, client }) => {
        await ack();
        const prUrl = action.value || '';
        const userId = body.user.id;
        console.log(`[Feedback] 👍 Helpful from ${userId} for ${prUrl}`);
        try {
            await (0, client_1.insertOrUpdateFeedback)(prUrl, userId, 'helpful');
        }
        catch (e) {
            console.error(`[Feedback] DB error: ${e.message}`);
        }
        try {
            await client.views.open({
                trigger_id: body.trigger_id,
                view: {
                    type: 'modal',
                    callback_id: 'ai_review_feedback_modal',
                    private_metadata: JSON.stringify({ pr_url: prUrl, rating: 'helpful' }),
                    title: { type: 'plain_text', text: 'Thanks for the feedback!' },
                    submit: { type: 'plain_text', text: 'Submit' },
                    close: { type: 'plain_text', text: 'Skip' },
                    blocks: [
                        {
                            type: 'input',
                            block_id: 'feedback_block',
                            optional: true,
                            element: {
                                type: 'plain_text_input',
                                action_id: 'feedback_text',
                                multiline: true,
                                placeholder: { type: 'plain_text', text: 'What was most helpful? (optional)' },
                            },
                            label: { type: 'plain_text', text: 'Any details to share?' },
                        },
                    ],
                },
            });
        }
        catch (e) {
            console.error(`[Feedback] Modal error: ${e.message}`);
        }
    });
    app.action('ai_review_not_helpful', async ({ action, ack, body, client }) => {
        await ack();
        const prUrl = action.value || '';
        const userId = body.user.id;
        console.log(`[Feedback] 👎 Not helpful from ${userId} for ${prUrl}`);
        try {
            await (0, client_1.insertOrUpdateFeedback)(prUrl, userId, 'not_helpful');
        }
        catch (e) {
            console.error(`[Feedback] DB error: ${e.message}`);
        }
        try {
            await client.views.open({
                trigger_id: body.trigger_id,
                view: {
                    type: 'modal',
                    callback_id: 'ai_review_feedback_modal',
                    private_metadata: JSON.stringify({ pr_url: prUrl, rating: 'not_helpful' }),
                    title: { type: 'plain_text', text: 'Help us improve' },
                    submit: { type: 'plain_text', text: 'Submit' },
                    close: { type: 'plain_text', text: 'Skip' },
                    blocks: [
                        {
                            type: 'input',
                            block_id: 'feedback_block',
                            optional: true,
                            element: {
                                type: 'plain_text_input',
                                action_id: 'feedback_text',
                                multiline: true,
                                placeholder: { type: 'plain_text', text: 'What went wrong or was inaccurate?' },
                            },
                            label: { type: 'plain_text', text: 'What could be improved?' },
                        },
                    ],
                },
            });
        }
        catch (e) {
            console.error(`[Feedback] Modal error: ${e.message}`);
        }
    });
    app.view('ai_review_feedback_modal', async ({ ack, view, body }) => {
        await ack();
        const userId = body.user.id;
        const metadata = JSON.parse(view.private_metadata || '{}');
        const prUrl = metadata.pr_url || '';
        const rating = metadata.rating || 'helpful';
        const feedbackText = view.state?.values?.feedback_block?.feedback_text?.value || '';
        if (feedbackText) {
            console.log(`[Feedback] Text from ${userId}: "${feedbackText.substring(0, 100)}"`);
            try {
                await (0, client_1.insertOrUpdateFeedback)(prUrl, userId, rating, feedbackText);
            }
            catch (e) {
                console.error(`[Feedback] DB error saving text: ${e.message}`);
            }
        }
    });
    // ---------------------------------------------------------------------------
    // Per-Comment AI Feedback — lightweight 👍/👎 on individual suggestions
    // ---------------------------------------------------------------------------
    app.action('comment_helpful', async ({ action, ack, body, respond }) => {
        await ack();
        const userId = body.user.id;
        try {
            const { pr_url, idx } = JSON.parse(action.value || '{}');
            console.log(`[Comment Feedback] 👍 from ${userId} on comment #${idx} for ${pr_url}`);
            await (0, client_1.insertOrUpdateCommentFeedback)(pr_url, idx, userId, 'helpful');
            await respond({ text: ':thumbsup: Thanks for the feedback!', response_type: 'ephemeral', replace_original: false });
        }
        catch (e) {
            console.error(`[Comment Feedback] Error: ${e.message}`);
        }
    });
    app.action('comment_not_helpful', async ({ action, ack, body, respond }) => {
        await ack();
        const userId = body.user.id;
        try {
            const { pr_url, idx } = JSON.parse(action.value || '{}');
            console.log(`[Comment Feedback] 👎 from ${userId} on comment #${idx} for ${pr_url}`);
            await (0, client_1.insertOrUpdateCommentFeedback)(pr_url, idx, userId, 'not_helpful');
            await respond({ text: ':thumbsdown: Got it — we\'ll work on improving this.', response_type: 'ephemeral', replace_original: false });
        }
        catch (e) {
            console.error(`[Comment Feedback] Error: ${e.message}`);
        }
    });
    return app;
}
//# sourceMappingURL=app.js.map