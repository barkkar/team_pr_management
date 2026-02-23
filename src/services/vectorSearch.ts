/**
 * Vector Search Service
 *
 * Provides similarity search over PR review embeddings and codebase knowledge
 * using pgvector cosine distance.
 */

import {
  searchSimilarReviews,
  searchSimilarCode,
  findReviewersByFiles,
  findCodeTouchersByFiles,
  PRReview,
  RepoKnowledge,
} from '../db/client';

export interface SimilarReview extends PRReview {
  similarity: number;
}

export interface SimilarCode extends RepoKnowledge {
  similarity: number;
}

export interface ReviewerCandidate {
  ghe_login: string;
  score: number;
  reason: string;
  files: string[];
}

/**
 * Find past review comments similar to a given embedding.
 */
export async function findSimilarReviews(
  embedding: number[],
  topK: number = 10,
  minSimilarity: number = 0.3,
): Promise<SimilarReview[]> {
  const results = await searchSimilarReviews(embedding, topK);
  return results.filter(r => r.similarity >= minSimilarity);
}

/**
 * Find codebase knowledge chunks similar to a given embedding.
 */
export async function findSimilarCodeChunks(
  embedding: number[],
  topK: number = 10,
  minSimilarity: number = 0.3,
): Promise<SimilarCode[]> {
  const results = await searchSimilarCode(embedding, topK);
  return results.filter(r => r.similarity >= minSimilarity);
}

/**
 * Find suggested reviewers based on file paths changed in a PR.
 * Combines three signals:
 *   1. People who reviewed similar files before (directory-level fuzzy match)
 *   2. People who authored changes to similar files
 *   3. People who appear in semantically similar past reviews (vector search)
 */
export async function findSuggestedReviewers(
  filePaths: string[],
  excludeAuthor?: string,
  topK: number = 5,
  similarReviews?: { reviewer_login?: string; similarity?: number }[],
): Promise<ReviewerCandidate[]> {
  const candidateMap = new Map<string, ReviewerCandidate & { hasReviewed: boolean; hasAuthored: boolean; hasSemantic: boolean }>();

  const ensureCandidate = (login: string) => {
    if (!candidateMap.has(login)) {
      candidateMap.set(login, {
        ghe_login: login, score: 0, reason: '', files: [],
        hasReviewed: false, hasAuthored: false, hasSemantic: false,
      });
    }
    return candidateMap.get(login)!;
  };

  // Signal 1: Past reviewers of the same/similar files (capped)
  const reviewers = await findReviewersByFiles(filePaths, 20);
  for (const r of reviewers) {
    if (excludeAuthor && r.reviewer_login === excludeAuthor) continue;
    const c = ensureCandidate(r.reviewer_login);
    c.score += Math.min(r.review_count, 20) * 2;
    c.files = [...new Set([...c.files, ...r.files])];
    c.hasReviewed = true;
  }

  // Signal 2: Past authors of changes to the same files (capped)
  const touchers = await findCodeTouchersByFiles(filePaths, 20);
  for (const t of touchers) {
    if (excludeAuthor && t.author_login === excludeAuthor) continue;
    const c = ensureCandidate(t.author_login);
    c.score += Math.min(t.change_count, 20);
    c.files = [...new Set([...c.files, ...t.files])];
    c.hasAuthored = true;
  }

  // Signal 3: Reviewers from semantically similar past reviews (vector search)
  if (similarReviews && similarReviews.length > 0) {
    const reviewerCounts = new Map<string, number>();
    for (const sr of similarReviews) {
      if (!sr.reviewer_login) continue;
      if (excludeAuthor && sr.reviewer_login === excludeAuthor) continue;
      reviewerCounts.set(sr.reviewer_login, (reviewerCounts.get(sr.reviewer_login) || 0) + 1);
    }
    for (const [login, count] of reviewerCounts) {
      const c = ensureCandidate(login);
      c.score += count * 3;
      c.hasSemantic = true;
    }
  }

  // Generate natural reasons
  for (const c of candidateMap.values()) {
    const parts: string[] = [];
    if (c.hasReviewed && c.hasAuthored) {
      parts.push("you've reviewed and contributed to similar files in this area");
    } else if (c.hasReviewed) {
      parts.push("you've reviewed similar files in this area before");
    } else if (c.hasAuthored) {
      parts.push("you've made changes to related code");
    }
    if (c.hasSemantic) {
      parts.push(parts.length > 0
        ? 'and have context from reviewing closely related PRs'
        : "you've reviewed closely related PRs before");
    }
    c.reason = parts.join(' ') || 'familiar with this area of the codebase';
  }

  // Sort by score descending and take top K
  return Array.from(candidateMap.values())
    .map(({ hasReviewed, hasAuthored, hasSemantic, ...rest }) => rest)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
