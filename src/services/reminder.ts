import { App } from '@slack/bolt';
import { getPendingReminders, markReminderSent, markPRClosed, TrackedPR } from '../db/client';
import { GitHubEnterpriseClient } from './github';
import { formatTimeAgo } from '../utils/timezone';

/**
 * Process pending reminders and send messages for PRs without reviews
 */
export async function processPendingReminders(app: App): Promise<void> {
  console.log('Checking for pending PR reminders...');
  
  const github = new GitHubEnterpriseClient();
  const pendingPRs = await getPendingReminders();
  
  console.log(`Found ${pendingPRs.length} PRs eligible for reminders`);
  
  for (const pr of pendingPRs) {
    try {
      await processReminder(app, github, pr);
    } catch (error) {
      console.error(`Error processing reminder for PR ${pr.pr_url}:`, error);
    }
  }
  
  console.log('Finished processing reminders');
}

async function processReminder(app: App, github: GitHubEnterpriseClient, pr: TrackedPR): Promise<void> {
  // Check if PR is still open
  const isOpen = await github.isPROpen(pr.org, pr.repo, pr.pr_number);
  
  if (!isOpen) {
    console.log(`PR ${pr.pr_url} is closed/merged, marking as closed`);
    await markPRClosed(pr.id);
    return;
  }
  
  // Check if PR has received reviews
  const hasReviews = await github.hasReviews(pr.org, pr.repo, pr.pr_number);
  
  if (hasReviews) {
    console.log(`PR ${pr.pr_url} has reviews, marking reminder as sent`);
    await markReminderSent(pr.id);
    return;
  }
  
  // No reviews - send reminder
  console.log(`Sending reminder for PR ${pr.pr_url}`);
  
  const timeAgo = formatTimeAgo(pr.posted_at);
  const message = buildReminderMessage(pr, timeAgo);
  
  await app.client.chat.postMessage({
    channel: pr.channel_id,
    text: message.text,
    blocks: message.blocks,
    unfurl_links: false,
  });
  
  await markReminderSent(pr.id);
  console.log(`Reminder sent for PR ${pr.pr_url}`);
}

function buildReminderMessage(pr: TrackedPR, timeAgo: string): { text: string; blocks: any[] } {
  const text = `👀 Reminder: This PR has been waiting for review for ${timeAgo}`;
  
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `👀 *PR Review Reminder*\n\nThis pull request has been waiting for review for *${timeAgo}*:`,
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `<${pr.pr_url}|${pr.org}/${pr.repo}#${pr.pr_number}>`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Posted in this channel • No reviews yet`,
        },
      ],
    },
  ];
  
  return { text, blocks };
}
