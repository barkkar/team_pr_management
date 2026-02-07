import { WebClient } from '@slack/web-api';

// Helper to add delay between API calls
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
import { trackPRsFromMessage } from './prTracker';
import { containsPRLink } from '../utils/prParser';
import { pool, getMonitoredChannels } from '../db/client';

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

  // Get monitored channels from database
  const monitoredChannels = await getMonitoredChannels();

  // Also check for legacy env var (for backward compatibility)
  const envChannelIds = process.env.POLL_CHANNEL_IDS?.split(',').map(id => id.trim()).filter(Boolean) || [];

  // Combine both sources, avoiding duplicates
  const channelMap = new Map<string, string>();
  
  for (const channel of monitoredChannels) {
    channelMap.set(channel.channel_id, channel.channel_name || channel.channel_id);
  }
  
  for (const channelId of envChannelIds) {
    if (!channelMap.has(channelId)) {
      channelMap.set(channelId, channelId);
    }
  }

  if (channelMap.size === 0) {
    console.log('No channels configured.');
    console.log('Use /pr-monitor add in a Slack channel to start monitoring it.');
    return;
  }

  console.log(`Polling ${channelMap.size} channel(s)`);

  for (const [channelId, channelName] of channelMap) {
    try {
      await pollChannel(client, channelId, channelName);
      await delay(500); // Delay between channels
    } catch (error) {
      console.error(`Error polling channel ${channelId}:`, error);
    }
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
