"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.trackPRsFromMessage = trackPRsFromMessage;
const client_1 = require("../db/client");
const prParser_1 = require("../utils/prParser");
const timezone_1 = require("../utils/timezone");
/**
 * Process a Slack message and track any PR links found
 */
async function trackPRsFromMessage(text, channelId, messageTs, postedAt) {
    const prs = (0, prParser_1.parsePRsFromMessage)(text);
    const result = {
        tracked: [],
        skipped: [],
    };
    if (prs.length === 0) {
        return result;
    }
    const { intervalHours, timezone } = await (0, client_1.getChannelReminderConfig)(channelId);
    for (const pr of prs) {
        const eligibleAt = (0, timezone_1.getEligibleReminderTime)(postedAt, intervalHours, timezone);
        const inserted = await (0, client_1.insertTrackedPR)({
            pr_url: pr.url,
            org: pr.org,
            repo: pr.repo,
            pr_number: pr.prNumber,
            channel_id: channelId,
            message_ts: messageTs,
            posted_at: postedAt,
            eligible_reminder_at: eligibleAt,
        });
        if (inserted) {
            result.tracked.push(pr);
            console.log(`Tracking PR: ${pr.url} (reminder eligible at ${eligibleAt.toISOString()})`);
        }
        else {
            result.skipped.push(pr);
            console.log(`Skipped PR (already tracked): ${pr.url}`);
        }
    }
    return result;
}
//# sourceMappingURL=prTracker.js.map