"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyError = notifyError;
const web_api_1 = require("@slack/web-api");
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const ERROR_CHANNEL_ID = process.env.ERROR_SLACK_CHANNEL_ID;
let slackClient = null;
function getClient() {
    if (!SLACK_BOT_TOKEN || !ERROR_CHANNEL_ID)
        return null;
    if (!slackClient)
        slackClient = new web_api_1.WebClient(SLACK_BOT_TOKEN);
    return slackClient;
}
// Throttle: track last notification per source+message to avoid flooding
const recentErrors = new Map();
const THROTTLE_MS = 60000; // 1 minute per unique source+message
function isThrottled(key) {
    const lastSent = recentErrors.get(key);
    if (lastSent && Date.now() - lastSent < THROTTLE_MS)
        return true;
    recentErrors.set(key, Date.now());
    // Prune old entries periodically
    if (recentErrors.size > 200) {
        const cutoff = Date.now() - THROTTLE_MS;
        for (const [k, v] of recentErrors) {
            if (v < cutoff)
                recentErrors.delete(k);
        }
    }
    return false;
}
const SEVERITY_EMOJI = {
    warn: ':warning:',
    error: ':x:',
    fatal: ':rotating_light:',
};
const SEVERITY_LABEL = {
    warn: 'Warning',
    error: 'Error',
    fatal: 'Fatal',
};
/**
 * Send an error notification to the configured Slack error channel.
 *
 * No-ops silently if ERROR_SLACK_CHANNEL_ID or SLACK_BOT_TOKEN is not set.
 * Throttles duplicate source+message combos to 1 per minute.
 * Never throws — safe to call from any catch block.
 */
async function notifyError(source, message, severity = 'error', details) {
    try {
        const client = getClient();
        if (!client)
            return;
        const throttleKey = `${source}::${message}`;
        if (isThrottled(throttleKey))
            return;
        const emoji = SEVERITY_EMOJI[severity];
        const label = SEVERITY_LABEL[severity];
        const ts = new Date().toISOString();
        const blocks = [
            {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `${emoji} *${label} in ${source}*\n>${message}`,
                },
            },
        ];
        if (details) {
            const truncated = details.length > 2500 ? details.substring(0, 2497) + '...' : details;
            blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: '```\n' + truncated + '\n```' },
            });
        }
        blocks.push({
            type: 'context',
            elements: [{ type: 'mrkdwn', text: `_${ts}_` }],
        });
        await client.chat.postMessage({
            channel: ERROR_CHANNEL_ID,
            text: `${label} in ${source}: ${message}`,
            blocks,
            unfurl_links: false,
        });
    }
    catch {
        // Never crash the caller
    }
}
//# sourceMappingURL=errorNotifier.js.map