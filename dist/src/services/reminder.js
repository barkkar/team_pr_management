"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.processPendingReminders = processPendingReminders;
const client_1 = require("../db/client");
const github_1 = require("./github");
const timezone_1 = require("../utils/timezone");
/**
 * Extract hostname from a PR URL
 * e.g., "https://gitcore.soma.salesforce.com/org/repo/pull/123" -> "gitcore.soma.salesforce.com"
 */
function extractHostname(prUrl) {
    const match = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)/);
    return match ? match[1] : null;
}
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
    // Extract hostname from PR URL
    const hostname = extractHostname(pr.pr_url);
    if (!hostname) {
        console.error(`Could not extract hostname from PR URL: ${pr.pr_url}`);
        return;
    }
    console.log(`Processing PR ${pr.pr_url} (hostname: ${hostname})`);
    let isOpen = true;
    let hasReviews = false;
    let apiAccessible = true;
    try {
        // Check if PR is still open
        isOpen = await github.isPROpen(hostname, pr.org, pr.repo, pr.pr_number);
        if (!isOpen) {
            console.log(`PR ${pr.pr_url} is closed/merged, marking as closed`);
            await (0, client_1.markPRClosed)(pr.id);
            return;
        }
        // Check if PR has received reviews
        hasReviews = await github.hasReviews(hostname, pr.org, pr.repo, pr.pr_number);
        if (hasReviews) {
            console.log(`PR ${pr.pr_url} has reviews, marking reminder as sent`);
            await (0, client_1.markReminderSent)(pr.id);
            return;
        }
    }
    catch (error) {
        // If we can't reach the GitHub API, still send the reminder (fail open)
        if (error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
            console.warn(`GitHub API not reachable for ${hostname}, sending reminder anyway (fail open)`);
            apiAccessible = false;
        }
        else {
            // For other errors (e.g., 404, 401), skip the reminder
            console.error(`GitHub API error for ${pr.pr_url}:`, error.message || error);
            return;
        }
    }
    // No reviews - send reminder
    console.log(`Sending reminder for PR ${pr.pr_url}`);
    const timeAgo = (0, timezone_1.formatTimeAgo)(pr.posted_at);
    const message = buildReminderMessage(pr, timeAgo, !apiAccessible);
    await app.client.chat.postMessage({
        channel: pr.channel_id,
        text: message.text,
        blocks: message.blocks,
        unfurl_links: false,
    });
    await (0, client_1.markReminderSent)(pr.id);
    console.log(`Reminder sent for PR ${pr.pr_url}`);
}
function buildReminderMessage(pr, timeAgo, apiNotChecked = false) {
    const text = `👀 Reminder: This PR has been waiting for review for ${timeAgo}`;
    const contextText = apiNotChecked
        ? `Posted in this channel • Could not check review status`
        : `Posted in this channel • No reviews yet`;
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
                    text: contextText,
                },
            ],
        },
    ];
    return { text, blocks };
}
//# sourceMappingURL=reminder.js.map