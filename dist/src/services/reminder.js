"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processPendingReminders = processPendingReminders;
const client_1 = require("../db/client");
const github_1 = require("./github");
const timezone_1 = require("../utils/timezone");
/**
 * Process pending reminders and send messages for PRs without reviews
 */
async function processPendingReminders(app) {
    console.log('Checking for pending PR reminders...');
    const github = new github_1.GitHubEnterpriseClient();
    const pendingPRs = await (0, client_1.getPendingReminders)();
    console.log(`Found ${pendingPRs.length} PRs eligible for reminders`);
    for (const pr of pendingPRs) {
        try {
            await processReminder(app, github, pr);
        }
        catch (error) {
            console.error(`Error processing reminder for PR ${pr.pr_url}:`, error);
        }
    }
    console.log('Finished processing reminders');
}
async function processReminder(app, github, pr) {
    // Check if PR is still open
    const isOpen = await github.isPROpen(pr.org, pr.repo, pr.pr_number);
    if (!isOpen) {
        console.log(`PR ${pr.pr_url} is closed/merged, marking as closed`);
        await (0, client_1.markPRClosed)(pr.id);
        return;
    }
    // Check if PR has received reviews
    const hasReviews = await github.hasReviews(pr.org, pr.repo, pr.pr_number);
    if (hasReviews) {
        console.log(`PR ${pr.pr_url} has reviews, marking reminder as sent`);
        await (0, client_1.markReminderSent)(pr.id);
        return;
    }
    // No reviews - send reminder
    console.log(`Sending reminder for PR ${pr.pr_url}`);
    const timeAgo = (0, timezone_1.formatTimeAgo)(pr.posted_at);
    const message = buildReminderMessage(pr, timeAgo);
    await app.client.chat.postMessage({
        channel: pr.channel_id,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
    });
    await (0, client_1.markReminderSent)(pr.id);
    console.log(`Reminder sent for PR ${pr.pr_url}`);
}
function buildReminderMessage(pr, timeAgo) {
    const text = `👀 Reminder: This PR has been waiting for review for ${timeAgo}`;
    const blocks = [
        {
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: `👀 *PR Review Reminder*\n\nThis pull request has been waiting for review for *${timeAgo}*:`,
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
                    text: `Posted in this channel • No reviews yet`,
                },
            ],
        },
    ];
    return { text, blocks };
}
//# sourceMappingURL=reminder.js.map