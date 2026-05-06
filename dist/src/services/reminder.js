"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processPendingReminders = processPendingReminders;
const client_1 = require("../db/client");
const timezone_1 = require("../utils/timezone");
/**
 * Process pending reminders and send messages for PRs without reviews.
 * Uses only worker-reported status from the database. Heroku cannot reach
 * internal GitHub Enterprise; the local worker must be running to report status.
 * Reminders are only sent between 9 AM - 5 PM PST (Mon-Fri).
 */
async function processPendingReminders(app) {
    console.log('Checking for pending PR reminders...');
    if (!(0, timezone_1.isWithinBusinessHours)()) {
        console.log('Outside business hours (9 AM - 5 PM PST). Skipping reminders.');
        return;
    }
    const pendingPRs = await (0, client_1.getPendingReminders)();
    console.log(`Found ${pendingPRs.length} PRs eligible for reminders`);
    for (const pr of pendingPRs) {
        try {
            await processReminder(app, pr);
        }
        catch (error) {
            console.error(`Error processing reminder for PR ${pr.pr_url}:`, error);
        }
    }
    console.log('Finished processing reminders');
}
async function processReminder(app, pr) {
    console.log(`Processing PR ${pr.pr_url}`);
    // Use only worker-reported status. Heroku cannot reach internal GHE.
    const workerStatusFresh = pr.status_checked_at &&
        (Date.now() - new Date(pr.status_checked_at).getTime()) < 10 * 60 * 1000;
    if (!workerStatusFresh || pr.is_open === undefined || pr.has_reviews === undefined) {
        console.warn(`  No recent worker status. Skipping. Ensure local worker is running to report status.`);
        return;
    }
    const isOpen = pr.is_open;
    const hasReviews = pr.has_reviews;
    console.log(`  Using worker-reported status (checked ${Math.round((Date.now() - new Date(pr.status_checked_at).getTime()) / 1000)}s ago)`);
    // Handle closed/merged PR
    if (!isOpen) {
        console.log(`  PR is closed/merged, marking as closed`);
        await (0, client_1.markPRClosed)(pr.id);
        return;
    }
    // Handle PR with reviews
    if (hasReviews) {
        console.log(`  PR has reviews, marking reminder as sent`);
        await (0, client_1.markReminderSent)(pr.id);
        return;
    }
    // No reviews - send reminder
    console.log(`  Sending reminder for PR ${pr.pr_url}`);
    const timeAgo = (0, timezone_1.formatTimeAgo)(pr.posted_at);
    const message = buildReminderMessage(pr, timeAgo, false);
    const base = {
        channel: pr.channel_id,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
    };
    const threadable = pr.message_ts && pr.message_ts !== '0';
    await app.client.chat.postMessage(threadable
        ? { ...base, thread_ts: pr.message_ts, reply_broadcast: true }
        : base);
    const nextAt = (0, timezone_1.getNextReminderEligibleTime)();
    await (0, client_1.scheduleNextReminder)(pr.id, nextAt);
    console.log(`  Reminder sent for PR ${pr.pr_url}, next reminder at ${nextAt.toISOString()}`);
}
function buildReminderMessage(pr, timeAgo, apiNotChecked = false) {
    const text = `:attentionspan: Reminder: This PR has been waiting for review for ${timeAgo}`;
    const contextText = apiNotChecked
        ? `Posted in this channel • Could not check review status`
        : `Posted in this channel • No reviews yet`;
    const blocks = [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `:attentionspan: *PR Review Reminder*\n\nThis pull request has been waiting for review for *${timeAgo}*:`,
            },
        },
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `<${pr.pr_url}|${pr.org}/${pr.repo}#${pr.pr_number}>`,
            },
        },
        {
            type: 'context',
            elements: [
                {
                    type: 'mrkdwn',
                    text: contextText,
                },
            ],
        },
    ];
    return { text, blocks };
}
//# sourceMappingURL=reminder.js.map