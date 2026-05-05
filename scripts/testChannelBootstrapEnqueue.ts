#!/usr/bin/env npx ts-node
/**
 * Test script: enqueue a Slack channel's members for bootstrap and print the
 * resulting rows from `channel_bootstrap_members`.
 *
 * Usage: npx ts-node scripts/testChannelBootstrapEnqueue.ts <channel-id>
 */

import 'dotenv/config';
import { WebClient } from '@slack/web-api';
import { enqueueChannelBootstrap } from '../src/services/channelBootstrap';
import { pool } from '../src/db/client';

async function main(): Promise<void> {
  const channelId = process.argv[2];
  if (!channelId) {
    console.error(
      'Usage: npx ts-node scripts/testChannelBootstrapEnqueue.ts <channel-id>',
    );
    process.exit(1);
  }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('SLACK_BOT_TOKEN is not set in the environment.');
    process.exit(1);
  }

  const slackClient = new WebClient(token);

  const { queued } = await enqueueChannelBootstrap(channelId, slackClient);
  console.log(`Enqueued ${queued} new row(s).`);

  const result = await pool.query(
    `SELECT id, slack_user_id, email, status, enqueued_at
     FROM channel_bootstrap_members
     WHERE channel_id = $1
     ORDER BY enqueued_at DESC
     LIMIT 50`,
    [channelId],
  );

  if (result.rows.length === 0) {
    console.log('(no rows)');
  } else {
    for (const row of result.rows) {
      console.log(
        `id=${row.id} slack_user_id=${row.slack_user_id} email=${row.email} status=${row.status} enqueued_at=${row.enqueued_at.toISOString()}`,
      );
    }
  }

  await pool.end();
}

main().catch(async err => {
  console.error(err);
  await pool.end();
  process.exit(1);
});
