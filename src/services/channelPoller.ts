import { WebClient } from '@slack/web-api';
import { trackPRsFromMessage } from './prTracker';
import { containsPRLink } from '../utils/prParser';
import { pool } from '../db/client';

// Store last poll timestamp per channel
async function getLastPollTime(channelId: string): Promise<string | null> {
  const result = await pool.query(
    'SELECT last_poll_ts FROM channel_poll_state WHERE channel_id = $1',
    [channelId]
  );
  return result.rows[0]?.last_poll_ts || null;
}

async function setLastPollTime(channelId: string, ts: string): Promise<void> {
  await pool.query(
    `INSERT INTO channel_poll_state (channel_id, last_poll_ts, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (channel_id) DO UPDATE SET last_poll_ts = $2, updated_at = NOW()`,
    [channelId, ts]
  );
}

export async function pollChannelsForPRs(client: WebClient): Promise<void> {
  console.log('Polling channels for PR messages...');

  try {
    // Get all channels with pagination
    const allChannels: any[] = [];
    let cursor: string | undefined;

    do {
      const channelsResult = await client.conversations.list({
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
        cursor: cursor,
      });

      if (channelsResult.channels) {
        allChannels.push(...channelsResult.channels);
      }

      cursor = channelsResult.response_metadata?.next_cursor;
    } while (cursor);

    if (allChannels.length === 0) {
      console.log('No channels found');
      return;
    }

    // Count channel types
    const publicCount = allChannels.filter(ch => !ch.is_private).length;
    const privateCount = allChannels.filter(ch => ch.is_private).length;
    console.log(`Found ${allChannels.length} total channels (${publicCount} public, ${privateCount} private)`);

    // Log if we find the test channel
    const testChannel = allChannels.find(ch => ch.name?.includes('pr-test'));
    if (testChannel) {
      console.log(`[DEBUG] Found pr-test channel: ${testChannel.name} (${testChannel.id}), is_private: ${testChannel.is_private}`);
    } else {
      console.log(`[DEBUG] pr-test channel NOT found in channel list`);
      // List all private channels for debugging
      const privateChannels = allChannels.filter(ch => ch.is_private);
      console.log(`[DEBUG] Private channels found: ${privateChannels.map(ch => ch.name).join(', ') || 'none'}`);
    }

    for (const channel of allChannels) {
      if (!channel.id) continue;

      try {
        await pollChannel(client, channel.id, channel.name || channel.id);
      } catch (error) {
        console.error(`Error polling channel ${channel.name || channel.id}:`, error);
      }
    }
  } catch (error) {
    console.error('Error listing channels:', error);
  }
}

async function pollChannel(client: WebClient, channelId: string, channelName: string): Promise<void> {
  const lastPollTs = await getLastPollTime(channelId);
  
  console.log(`Polling channel #${channelName} (${channelId}), last poll: ${lastPollTs || 'never'}`);

  try {
    // Get messages since last poll (or last 100 messages if first poll)
    const historyResult = await client.conversations.history({
      channel: channelId,
      oldest: lastPollTs || undefined,
      limit: 100,
    });

    if (!historyResult.messages || historyResult.messages.length === 0) {
      console.log(`  No new messages in #${channelName}`);
      return;
    }

    console.log(`  Found ${historyResult.messages.length} messages to check`);

    let newestTs = lastPollTs;
    let prCount = 0;

    for (const message of historyResult.messages) {
      // Skip bot messages and messages without text
      if (message.bot_id || !message.text || !message.ts) continue;

      // Track newest timestamp
      if (!newestTs || message.ts > newestTs) {
        newestTs = message.ts;
      }

      // Check for PR links
      if (!containsPRLink(message.text)) continue;

      console.log(`  Found PR link in message from ${message.user}`);

      const postedAt = new Date(parseFloat(message.ts) * 1000);
      
      try {
        const result = await trackPRsFromMessage(message.text, channelId, message.ts, postedAt);
        
        if (result.tracked.length > 0) {
          prCount += result.tracked.length;
          
          // Add reaction to acknowledge
          try {
            await client.reactions.add({
              channel: channelId,
              timestamp: message.ts,
              name: 'robot_face',
            });
          } catch (reactionError: any) {
            // Ignore "already_reacted" errors
            if (reactionError?.data?.error !== 'already_reacted') {
              console.log('  Could not add reaction:', reactionError?.data?.error || reactionError);
            }
          }
        }
      } catch (error) {
        console.error(`  Error tracking PR from message:`, error);
      }
    }

    // Update last poll timestamp
    if (newestTs) {
      await setLastPollTime(channelId, newestTs);
    }

    if (prCount > 0) {
      console.log(`  Tracked ${prCount} new PR(s) in #${channelName}`);
    }
  } catch (error: any) {
    if (error?.data?.error === 'not_in_channel') {
      console.log(`  Bot is not in channel #${channelName}, skipping`);
    } else {
      throw error;
    }
  }
}
