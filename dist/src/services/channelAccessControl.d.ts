/**
 * Channel Access Control
 *
 * Enforces an allowlist of Slack channel IDs that this bot is permitted to
 * read conversation history from. This satisfies Slack admin requirements
 * for the `groups:history` (private channels) and `channels:history`
 * (public channels) scopes by ensuring code-level controls prevent the bot
 * from reading messages in channels not explicitly approved.
 *
 * The allowlist is loaded from the ALLOWED_CHANNEL_IDS environment variable
 * (comma-separated Slack channel IDs, e.g. "C0123ABC,G0456DEF").
 */
/**
 * Returns true if the given channel ID is in the allowlist.
 */
export declare function isChannelAllowed(channelId: string): boolean;
/**
 * Throws an error if the given channel ID is NOT in the allowlist.
 * Also logs the denied access attempt for audit purposes.
 *
 * @param channelId  Slack channel ID to check
 * @param context    Human-readable label for the code path (e.g. "Socket Mode", "Channel Poller")
 */
export declare function assertChannelAllowed(channelId: string, context: string): void;
/**
 * Returns the full list of allowed channel IDs (for status / debugging).
 */
export declare function getAllowedChannelIds(): string[];
//# sourceMappingURL=channelAccessControl.d.ts.map