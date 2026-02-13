/**
 * Scheduled job to:
 * 1. Poll channels for new PR messages
 * 2. Check for PRs that need review reminders
 * Run this via Heroku Scheduler every 10-15 minutes
 */
import 'dotenv/config';
import { WebClient } from '@slack/web-api';
import { App } from '@slack/bolt';
import { pollChannelsForPRs } from '../src/services/channelPoller';
import { processPendingReminders } from '../src/services/reminder';
import { pool } from '../src/db/client';

async function main(): Promise<void> {
  console.log('Starting scheduled job...');
  console.log(`Time: ${new Date().toISOString()}`);

  // Validate required environment variables
  const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'GHE_TOKEN', 'DATABASE_URL', 'ALLOWED_CHANNEL_IDS'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Create Slack Web API client for polling
  const client = new WebClient(process.env.SLACK_BOT_TOKEN);

  // Create a minimal Slack app instance for posting messages
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
  });

  try {
    // Step 1: Poll channels for new PR messages
    console.log('\n=== Polling channels for PR messages ===');
    await pollChannelsForPRs(client);

    // Step 2: Check for PRs that need reminders
    console.log('\n=== Checking for pending reminders ===');
    await processPendingReminders(app);

    console.log('\nScheduled job completed successfully');
  } catch (error) {
    console.error('Error during scheduled job:', error);
    process.exit(1);
  } finally {
    // Close database connection
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
