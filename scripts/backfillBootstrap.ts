import 'dotenv/config';
import { WebClient } from '@slack/web-api';
import { pool, getMonitoredChannels, insertBootstrapMembers } from '../src/db/client';

async function fetchChannelMemberIds(slack: WebClient, channelId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const resp = await slack.conversations.members({ channel: channelId, limit: 1000, cursor });
    if (!resp.ok) throw new Error(`conversations.members failed: ${resp.error}`);
    for (const id of resp.members || []) ids.push(id);
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return ids;
}

async function fetchMemberRows(
  slack: WebClient,
  channelId: string,
  memberIds: string[],
): Promise<{ channel_id: string; slack_user_id: string; email: string }[]> {
  const rows: { channel_id: string; slack_user_id: string; email: string }[] = [];
  for (const slackUserId of memberIds) {
    try {
      const resp = await slack.users.info({ user: slackUserId });
      if (!resp.ok || !resp.user) continue;
      const u = resp.user;
      if (u.is_bot) continue;
      if (u.deleted) continue;
      const email = u.profile?.email;
      if (!email) continue;
      rows.push({ channel_id: channelId, slack_user_id: slackUserId, email });
    } catch (err: any) {
      console.error(`    users.info ${slackUserId} failed: ${err.message}`);
    }
  }
  return rows;
}

async function backfillChannel(slack: WebClient, channelId: string): Promise<void> {
  const memberIds = await fetchChannelMemberIds(slack, channelId);
  console.log(`  ${channelId}: ${memberIds.length} member(s) in channel`);
  const rows = await fetchMemberRows(slack, channelId, memberIds);
  const inserted = await insertBootstrapMembers(rows);
  console.log(`  ${channelId}: queued ${inserted} new row(s) (${rows.length} eligible after filtering bots/deleted/no-email)`);
}

async function main(): Promise<void> {
  const required = ['SLACK_BOT_TOKEN', 'DATABASE_URL'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing env: ${missing.join(', ')}`);
    process.exit(1);
  }

  const argChannels = process.argv.slice(2).filter((a) => a.startsWith('C'));
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

  let channels: string[];
  if (argChannels.length > 0) {
    channels = argChannels;
  } else {
    const result = await pool.query<{ channel_id: string }>(
      `SELECT mc.channel_id
       FROM monitored_channels mc
       LEFT JOIN channel_bootstrap_members cbm ON cbm.channel_id = mc.channel_id
       WHERE mc.enabled = TRUE AND cbm.id IS NULL
       GROUP BY mc.channel_id
       ORDER BY mc.channel_id`,
    );
    channels = result.rows.map((r) => r.channel_id);
  }

  console.log(`Backfilling ${channels.length} channel(s): ${channels.join(', ')}`);

  for (const channelId of channels) {
    try {
      await backfillChannel(slack, channelId);
    } catch (err: any) {
      console.error(`  ${channelId}: FAILED — ${err.message}`);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
