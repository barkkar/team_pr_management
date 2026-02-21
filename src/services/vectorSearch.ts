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
 * Combines two signals:
 *   1. People who reviewed similar files before
 *   2. People who authored changes to similar files
 */
export async function findSuggestedReviewers(
  filePaths: string[],
  excludeAuthor?: string,
  topK: number = 5,
): Promise<ReviewerCandidate[]> {
  const candidateMap = new Map<string, ReviewerCandidate>();

  // Signal 1: Past reviewers of the same/similar files
  const reviewers = await findReviewersByFiles(filePaths, 20);
  for (const r of reviewers) {
    if (excludeAuthor && r.reviewer_login === excludeAuthor) continue;
    const existing = candidateMap.get(r.reviewer_login);
    if (existing) {
      existing.score += r.review_count * 2; // Reviews are weighted more
      existing.files = [...new Set([...existing.files, ...r.files])];
    } else {
      candidateMap.set(r.reviewer_login, {
        ghe_login: r.reviewer_login,
        score: r.review_count * 2,
        reason: `reviewed ${r.review_count} similar file(s)`,
        files: r.files,
      });
    }
  }

  // Signal 2: Past authors of changes to the same files
  const touchers = await findCodeTouchersByFiles(filePaths, 20);
  for (const t of touchers) {
    if (excludeAuthor && t.author_login === excludeAuthor) continue;
    const existing = candidateMap.get(t.author_login);
    if (existing) {
      existing.score += t.change_count;
      existing.files = [...new Set([...existing.files, ...t.files])];
      existing.reason += `, changed ${t.change_count} related file(s)`;
    } else {
      candidateMap.set(t.author_login, {
        ghe_login: t.author_login,
        score: t.change_count,
        reason: `changed ${t.change_count} related file(s)`,
        files: t.files,
      });
    }
  }

  // Sort by score descending and take top K
  return Array.from(candidateMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
