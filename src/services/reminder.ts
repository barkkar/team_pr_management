import { App } from '@slack/bolt';
import { getPendingReminders, markReminderSent, markPRClosed, TrackedPR } from '../db/client';
import { GitHubEnterpriseClient } from './github';
import { formatTimeAgo } from '../utils/timezone';

/**
 * Extract hostname from a PR URL
 * e.g., "https://gitcore.soma.salesforce.com/org/repo/pull/123" -> "gitcore.soma.salesforce.com"
 */
function extractHostname(prUrl: string): string | null {
  const match = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)/);
  return match ? match[1] : null;
}

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
  console.log(`Processing PR ${pr.pr_url}`);
  
  let isOpen = true;
  let hasReviews = false;
  let statusFromWorker = false;
  
  // Check if we have recent worker-reported status (within last 10 minutes)
  const workerStatusFresh = pr.status_checked_at && 
    (Date.now() - new Date(pr.status_checked_at).getTime()) < 10 * 60 * 1000;
  
  if (workerStatusFresh && pr.is_open !== undefined && pr.has_reviews !== undefined) {
    // Use worker-reported status
    console.log(`  Using worker-reported status (checked ${Math.round((Date.now() - new Date(pr.status_checked_at!).getTime()) / 1000)}s ago)`);
    isOpen = pr.is_open;
    hasReviews = pr.has_reviews;
    statusFromWorker = true;
  } else {
    // Fall back to direct GitHub API call (will fail if not on VPN)
    const hostname = extractHostname(pr.pr_url);
    
    if (!hostname) {
      console.error(`Could not extract hostname from PR URL: ${pr.pr_url}`);
      return;
    }
    
    console.log(`  No recent worker status, trying direct GitHub API (hostname: ${hostname})`);
    
    try {
      isOpen = await github.isPROpen(hostname, pr.org, pr.repo, pr.pr_number);
      
      if (isOpen) {
        hasReviews = await github.hasReviews(hostname, pr.org, pr.repo, pr.pr_number);
      }
    } catch (error: any) {
      // If we can't reach the GitHub API, still send the reminder (fail open)
      if (error.code === 'ENOTFOUND' || error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
        console.warn(`  GitHub API not reachable, sending reminder anyway (fail open)`);
        // Send reminder with unknown status
        const timeAgo = formatTimeAgo(pr.posted_at);
        const message = buildReminderMessage(pr, timeAgo, true);
        
        await app.client.chat.postMessage({
          channel: pr.channel_id,
          text: message.text,
          blocks: message.blocks,
          unfurl_links: false,
        });
        
        await markReminderSent(pr.id);
        console.log(`  Reminder sent for PR ${pr.pr_url} (status unknown)`);
        return;
      } else {
        // For other errors (e.g., 404, 401), skip the reminder
        console.error(`  GitHub API error for ${pr.pr_url}:`, error.message || error);
        return;
      }
    }
  }
  
  // Handle closed/merged PR
  if (!isOpen) {
    console.log(`  PR is closed/merged, marking as closed`);
    await markPRClosed(pr.id);
    return;
  }
  
  // Handle PR with reviews
  if (hasReviews) {
    console.log(`  PR has reviews, marking reminder as sent`);
    await markReminderSent(pr.id);
    return;
  }
  
  // No reviews - send reminder
  console.log(`  Sending reminder for PR ${pr.pr_url}`);
  
  const timeAgo = formatTimeAgo(pr.posted_at);
  const message = buildReminderMessage(pr, timeAgo, false);
  
  await app.client.chat.postMessage({
    channel: pr.channel_id,
    text: message.text,
    blocks: message.blocks,
    unfurl_links: false,
  });
  
  await markReminderSent(pr.id);
  console.log(`  Reminder sent for PR ${pr.pr_url}`);
}

function buildReminderMessage(pr: TrackedPR, timeAgo: string, apiNotChecked: boolean = false): { text: string; blocks: any[] } {
  const text = `:attentionspan: Reminder: This PR has been waiting for review for ${timeAgo}`;
  
  const contextText = apiNotChecked 
    ? `Posted in this channel • Could not check review status`
    : `Posted in this channel • No reviews yet`;
  
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:attentionspan: *PR Review Reminder*\n\nThis pull request has been waiting for review for *${timeAgo}*:`,
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
          text: contextText,
        },
      ],
    },
  ];
  
  return { text, blocks };
}
