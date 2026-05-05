import type { WebClient } from '@slack/web-api';
import { insertBootstrapMembers } from '../db/client';

// ========== Types + module-level cache state ==========

interface UsersDirectoryEntry {
  is_bot: boolean;
  deleted: boolean;
  email: string | null;
}

type UsersDirectory = Map<string, UsersDirectoryEntry>;

// Module-level TTL cache + single-flight mutex for `users.list`. The Slack
// `users.list` endpoint is Tier 2 and the workspace directory is stable
// over short intervals, so we cache it for 5 minutes and coalesce concurrent
// callers onto a single in-flight fetch to avoid rate-limit bursts.
let usersListCache: { fetchedAt: number; users: UsersDirectory } | null = null;
let inflight: Promise<UsersDirectory> | null = null;
const USERS_LIST_TTL_MS = 5 * 60 * 1000;

// Pacing delay between `users.list` pages. Matches the pattern in
// worker/userMapper.ts:121.
const USERS_LIST_PAGE_DELAY_MS = 200;

// ========== Private helpers ==========

/**
 * Paginate `users.list` until exhausted and return a map keyed by Slack user
 * ID. Throws if the API returns `ok: false`.
 */
async function fetchUsersListPaginated(
  slackClient: WebClient,
): Promise<UsersDirectory> {
  const directory: UsersDirectory = new Map();
  let cursor: string | undefined;

  do {
    const response = await slackClient.users.list({
      limit: 200,
      cursor,
    });

    if (!response.ok) {
      throw new Error(`users.list failed: ${response.error}`);
    }

    for (const member of response.members || []) {
      if (!member.id) continue;
      const email = member.profile?.email ?? null;
      directory.set(member.id, {
        is_bot: Boolean(member.is_bot),
        deleted: Boolean(member.deleted),
        email: email || null,
      });
    }

    cursor = response.response_metadata?.next_cursor || undefined;

    // Pace between pages to stay under Slack's Tier 2 rate limit.
    if (cursor) {
      await new Promise(resolve => setTimeout(resolve, USERS_LIST_PAGE_DELAY_MS));
    }
  } while (cursor);

  return directory;
}

/**
 * Return a cached users directory if it's fresh; otherwise fetch via
 * `users.list`. Concurrent callers share a single in-flight promise.
 */
async function getUsersDirectory(slackClient: WebClient): Promise<UsersDirectory> {
  const now = Date.now();
  if (usersListCache && now - usersListCache.fetchedAt < USERS_LIST_TTL_MS) {
    return usersListCache.users;
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const users = await fetchUsersListPaginated(slackClient);
      usersListCache = { fetchedAt: Date.now(), users };
      return users;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Paginate `conversations.members` until exhausted and return the set of
 * Slack user IDs in the channel. Throws if the API returns `ok: false`.
 */
async function fetchChannelMemberIds(
  slackClient: WebClient,
  channelId: string,
): Promise<Set<string>> {
  const memberIds = new Set<string>();
  let cursor: string | undefined;

  do {
    const response = await slackClient.conversations.members({
      channel: channelId,
      limit: 1000,
      cursor,
    });

    if (!response.ok) {
      throw new Error(`conversations.members failed: ${response.error}`);
    }

    for (const id of response.members || []) {
      memberIds.add(id);
    }

    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return memberIds;
}

// ========== Exported entry point ==========

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
export async function enqueueChannelBootstrap(
  channelId: string,
  slackClient: WebClient,
): Promise<{ queued: number }> {
  const memberIds = await fetchChannelMemberIds(slackClient, channelId);
  const directory = await getUsersDirectory(slackClient);

  const rows: { channel_id: string; slack_user_id: string; email: string }[] = [];
  for (const slackUserId of memberIds) {
    const entry = directory.get(slackUserId);
    if (!entry) continue;
    if (entry.is_bot) continue;
    if (entry.deleted) continue;
    if (!entry.email) continue;
    rows.push({
      channel_id: channelId,
      slack_user_id: slackUserId,
      email: entry.email,
    });
  }

  const insertedCount = await insertBootstrapMembers(rows);
  return { queued: insertedCount };
}
