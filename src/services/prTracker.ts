import { insertTrackedPR, getChannelReminderConfig } from '../db/client';
import { parsePRsFromMessage, ParsedPR } from '../utils/prParser';
import { getEligibleReminderTime } from '../utils/timezone';

export interface TrackingResult {
  tracked: ParsedPR[];
  skipped: ParsedPR[];
}

/**
 * Process a Slack message and track any PR links found
 */
export async function trackPRsFromMessage(
  text: string,
  channelId: string,
  messageTs: string,
  postedAt: Date
): Promise<TrackingResult> {
  const prs = parsePRsFromMessage(text);
  const result: TrackingResult = {
    tracked: [],
    skipped: [],
  };

  if (prs.length === 0) {
    return result;
  }

  const { intervalHours, timezone } = await getChannelReminderConfig(channelId);

  for (const pr of prs) {
    const eligibleAt = getEligibleReminderTime(postedAt, intervalHours, timezone);
    const inserted = await insertTrackedPR({
      pr_url: pr.url,
      org: pr.org,
      repo: pr.repo,
      pr_number: pr.prNumber,
      channel_id: channelId,
      message_ts: messageTs,
      posted_at: postedAt,
      eligible_reminder_at: eligibleAt,
    });

    if (inserted) {
      result.tracked.push(pr);
      console.log(`Tracking PR: ${pr.url} (reminder eligible at ${eligibleAt.toISOString()})`);
    } else {
      result.skipped.push(pr);
      console.log(`Skipped PR (already tracked): ${pr.url}`);
    }
  }

  return result;
}
