/**
 * Reviewer Suggester
 *
 * Identifies the best reviewers for a PR based on:
 * - Past review history on similar files
 * - Code authorship history
 * - GHE → Slack user mapping for @mentions
 */

import { getUserMapping } from '../db/client';
import { findSuggestedReviewers, ReviewerCandidate } from './vectorSearch';

export interface SuggestedReviewer {
  ghe_login: string;
  slack_user_id: string | null;
  display_name: string | null;
  score: number;
  reason: string;
  files: string[];
}

/**
 * Get suggested reviewers for a PR, resolved with Slack user IDs where possible.
 */
export async function getSuggestedReviewers(
  changedFiles: string[],
  prAuthor?: string,
  topK: number = 5,
): Promise<SuggestedReviewer[]> {
  // Get raw candidates from vector search / DB queries
  const candidates = await findSuggestedReviewers(changedFiles, prAuthor, topK);

  if (candidates.length === 0) {
    return [];
  }

  // Resolve GHE logins to Slack user IDs
  const results: SuggestedReviewer[] = [];

  for (const candidate of candidates) {
    const mapping = await getUserMapping(candidate.ghe_login);

    results.push({
      ghe_login: candidate.ghe_login,
      slack_user_id: mapping?.slack_user_id || null,
      display_name: mapping?.display_name || null,
      score: candidate.score,
      reason: candidate.reason,
      files: candidate.files,
    });
  }

  return results;
}

/**
 * Format reviewer suggestions for Slack display.
 * Uses @mention for users with Slack IDs, falls back to GHE login.
 */
export function formatReviewerSuggestions(reviewers: SuggestedReviewer[]): string {
  if (reviewers.length === 0) {
    return '_No reviewer suggestions available yet. Run the harvester to build review history._';
  }

  const lines = reviewers.map((r, i) => {
    const mention = r.slack_user_id ? `<@${r.slack_user_id}>` : `\`${r.ghe_login}\``;
    const name = r.display_name ? ` (${r.display_name})` : '';
    return `${i + 1}. ${mention}${name} — ${r.reason}`;
  });

  return lines.join('\n');
}
