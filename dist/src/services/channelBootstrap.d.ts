import type { WebClient } from '@slack/web-api';
/**
 * Enqueue every real (non-bot, non-deleted, has-email) member of a Slack
 * channel into `channel_bootstrap_members` for proactive GHE user mapping.
 *
 * Throws on Slack API errors; the caller (see `src/app.ts` Packet C4) is
 * responsible for classifying scope-vs-transient errors and funneling them
 * through `notifyError`.
 *
 * @returns `{ queued }` — the number of freshly inserted rows (duplicates on
 *   `(channel_id, slack_user_id)` are silently skipped by the DB layer).
 */
export declare function enqueueChannelBootstrap(channelId: string, slackClient: WebClient): Promise<{
    queued: number;
}>;
//# sourceMappingURL=channelBootstrap.d.ts.map