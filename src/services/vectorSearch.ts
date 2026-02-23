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
  const candidateMap = new Map<string, ReviewerCandidate>();

  // Signal 1: Past reviewers of the same/similar files (capped to avoid fuzzy match inflation)
  const reviewers = await findReviewersByFiles(filePaths, 20);
  for (const r of reviewers) {
    if (excludeAuthor && r.reviewer_login === excludeAuthor) continue;
    const cappedCount = Math.min(r.review_count, 20);
    const existing = candidateMap.get(r.reviewer_login);
    if (existing) {
      existing.score += cappedCount * 2;
      existing.files = [...new Set([...existing.files, ...r.files])];
    } else {
      candidateMap.set(r.reviewer_login, {
        ghe_login: r.reviewer_login,
        score: cappedCount * 2,
        reason: `reviewed ${r.review_count} similar file(s)`,
        files: r.files,
      });
    }
  }

  // Signal 2: Past authors of changes to the same files (capped)
  const touchers = await findCodeTouchersByFiles(filePaths, 20);
  for (const t of touchers) {
    if (excludeAuthor && t.author_login === excludeAuthor) continue;
    const cappedCount = Math.min(t.change_count, 20);
    const existing = candidateMap.get(t.author_login);
    if (existing) {
      existing.score += cappedCount;
      existing.files = [...new Set([...existing.files, ...t.files])];
      existing.reason += `, changed ${t.change_count} related file(s)`;
    } else {
      candidateMap.set(t.author_login, {
        ghe_login: t.author_login,
        score: cappedCount,
        reason: `changed ${t.change_count} related file(s)`,
        files: t.files,
      });
    }
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
      const semanticScore = count * 3; // Semantic relevance weighted highest
      const existing = candidateMap.get(login);
      if (existing) {
        existing.score += semanticScore;
        existing.reason += `, ${count} semantically similar review(s)`;
      } else {
        candidateMap.set(login, {
          ghe_login: login,
          score: semanticScore,
          reason: `${count} semantically similar review(s)`,
          files: [],
        });
      }
    }
  }

  // Sort by score descending and take top K
  return Array.from(candidateMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
