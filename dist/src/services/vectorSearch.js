"use strict";
/**
 * Vector Search Service
 *
 * Provides similarity search over PR review embeddings and codebase knowledge
 * using pgvector cosine distance.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.findSimilarReviews = findSimilarReviews;
exports.findSimilarCodeChunks = findSimilarCodeChunks;
exports.findSuggestedReviewers = findSuggestedReviewers;
const client_1 = require("../db/client");
/**
 * Find past review comments similar to a given embedding.
 */
async function findSimilarReviews(embedding, topK = 10, minSimilarity = 0.3) {
    const results = await (0, client_1.searchSimilarReviews)(embedding, topK);
    return results.filter(r => r.similarity >= minSimilarity);
}
/**
 * Find codebase knowledge chunks similar to a given embedding.
 */
async function findSimilarCodeChunks(embedding, topK = 10, minSimilarity = 0.3) {
    const results = await (0, client_1.searchSimilarCode)(embedding, topK);
    return results.filter(r => r.similarity >= minSimilarity);
}
/**
 * Find suggested reviewers based on file paths changed in a PR.
 * Combines three signals:
 *   1. People who reviewed similar files before (directory-level fuzzy match)
 *   2. People who authored changes to similar files
 *   3. People who appear in semantically similar past reviews (vector search)
 */
async function findSuggestedReviewers(filePaths, excludeAuthor, topK = 5, similarReviews) {
    const candidateMap = new Map();
    // Signal 1: Past reviewers of the same/similar files
    const reviewers = await (0, client_1.findReviewersByFiles)(filePaths, 20);
    for (const r of reviewers) {
        if (excludeAuthor && r.reviewer_login === excludeAuthor)
            continue;
        const existing = candidateMap.get(r.reviewer_login);
        if (existing) {
            existing.score += r.review_count * 2; // Reviews are weighted more
            existing.files = [...new Set([...existing.files, ...r.files])];
        }
        else {
            candidateMap.set(r.reviewer_login, {
                ghe_login: r.reviewer_login,
                score: r.review_count * 2,
                reason: `reviewed ${r.review_count} similar file(s)`,
                files: r.files,
            });
        }
    }
    // Signal 2: Past authors of changes to the same files
    const touchers = await (0, client_1.findCodeTouchersByFiles)(filePaths, 20);
    for (const t of touchers) {
        if (excludeAuthor && t.author_login === excludeAuthor)
            continue;
        const existing = candidateMap.get(t.author_login);
        if (existing) {
            existing.score += t.change_count;
            existing.files = [...new Set([...existing.files, ...t.files])];
            existing.reason += `, changed ${t.change_count} related file(s)`;
        }
        else {
            candidateMap.set(t.author_login, {
                ghe_login: t.author_login,
                score: t.change_count,
                reason: `changed ${t.change_count} related file(s)`,
                files: t.files,
            });
        }
    }
    // Signal 3: Reviewers from semantically similar past reviews (vector search)
    if (similarReviews && similarReviews.length > 0) {
        const reviewerCounts = new Map();
        for (const sr of similarReviews) {
            if (!sr.reviewer_login)
                continue;
            if (excludeAuthor && sr.reviewer_login === excludeAuthor)
                continue;
            reviewerCounts.set(sr.reviewer_login, (reviewerCounts.get(sr.reviewer_login) || 0) + 1);
        }
        for (const [login, count] of reviewerCounts) {
            const semanticScore = count * 3; // Semantic relevance weighted highest
            const existing = candidateMap.get(login);
            if (existing) {
                existing.score += semanticScore;
                existing.reason += `, ${count} semantically similar review(s)`;
            }
            else {
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
//# sourceMappingURL=vectorSearch.js.map