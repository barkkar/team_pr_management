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

// ---------------------------------------------------------------------------
// Load and validate the allowlist at module init time
// ---------------------------------------------------------------------------

const rawAllowlist = process.env.ALLOWED_CHANNEL_IDS || '';

const ALLOWED_CHANNEL_IDS: ReadonlySet<string> = new Set(
  rawAllowlist
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);

if (ALLOWED_CHANNEL_IDS.size === 0) {
  console.error(
    '[Channel Access Control] FATAL: ALLOWED_CHANNEL_IDS environment variable is not set or empty. ' +
      'The bot cannot start without an explicit channel allowlist. ' +
      'Set ALLOWED_CHANNEL_IDS to a comma-separated list of Slack channel IDs.',
  );
  process.exit(1);
}

console.log(
  `[Channel Access Control] Loaded allowlist with ${ALLOWED_CHANNEL_IDS.size} channel(s): ${[...ALLOWED_CHANNEL_IDS].join(', ')}`,
);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if the given channel ID is in the allowlist.
 */
export function isChannelAllowed(channelId: string): boolean {
  return ALLOWED_CHANNEL_IDS.has(channelId);
}

/**
 * Throws an error if the given channel ID is NOT in the allowlist.
 * Also logs the denied access attempt for audit purposes.
 *
 * @param channelId  Slack channel ID to check
 * @param context    Human-readable label for the code path (e.g. "Socket Mode", "Channel Poller")
 */
export function assertChannelAllowed(channelId: string, context: string): void {
  if (!isChannelAllowed(channelId)) {
    const msg = `[Channel Access Control] DENIED: ${context} attempted to access non-allowlisted channel ${channelId}`;
    console.error(msg);
    throw new Error(msg);
  }
}

/**
 * Returns the full list of allowed channel IDs (for status / debugging).
 */
export function getAllowedChannelIds(): string[] {
  return [...ALLOWED_CHANNEL_IDS];
}
