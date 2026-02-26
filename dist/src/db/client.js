"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.insertTrackedPR = insertTrackedPR;
exports.getPendingReminders = getPendingReminders;
exports.markReminderSent = markReminderSent;
exports.scheduleNextReminder = scheduleNextReminder;
exports.getOpenUnreviewedPRs = getOpenUnreviewedPRs;
exports.markPRClosed = markPRClosed;
exports.getTrackedPRByUrl = getTrackedPRByUrl;
exports.getPRsNeedingStatusCheck = getPRsNeedingStatusCheck;
exports.updatePRStatus = updatePRStatus;
exports.addMonitoredChannel = addMonitoredChannel;
exports.removeMonitoredChannel = removeMonitoredChannel;
exports.getMonitoredChannels = getMonitoredChannels;
exports.isChannelMonitored = isChannelMonitored;
exports.getReviewStats = getReviewStats;
exports.insertPRReview = insertPRReview;
exports.getPRReviewCount = getPRReviewCount;
exports.insertPRFile = insertPRFile;
exports.upsertUserMapping = upsertUserMapping;
exports.getUserMapping = getUserMapping;
exports.getAllUserMappings = getAllUserMappings;
exports.getHarvestState = getHarvestState;
exports.upsertHarvestState = upsertHarvestState;
exports.upsertRepoHarvestState = upsertRepoHarvestState;
exports.upsertRepoKnowledge = upsertRepoKnowledge;
exports.deleteRepoKnowledgeForFile = deleteRepoKnowledgeForFile;
exports.insertEmbedding = insertEmbedding;
exports.updateRepoKnowledgeEmbedding = updateRepoKnowledgeEmbedding;
exports.getUnembeddedPRReviews = getUnembeddedPRReviews;
exports.getUnembeddedRepoKnowledge = getUnembeddedRepoKnowledge;
exports.searchSimilarReviews = searchSimilarReviews;
exports.searchSimilarCode = searchSimilarCode;
exports.findReviewersByFiles = findReviewersByFiles;
exports.findCodeTouchersByFiles = findCodeTouchersByFiles;
exports.getDistinctRepos = getDistinctRepos;
exports.insertOrUpdateFeedback = insertOrUpdateFeedback;
exports.getRecentFeedback = getRecentFeedback;
exports.insertOrUpdateCommentFeedback = insertOrUpdateCommentFeedback;
exports.getCommentFeedbackStats = getCommentFeedbackStats;
exports.insertReviewLessons = insertReviewLessons;
exports.getRecentLessons = getRecentLessons;
exports.getSimilarLessons = getSimilarLessons;
exports.getPRsNeedingLessonExtraction = getPRsNeedingLessonExtraction;
exports.searchSimilarDocs = searchSimilarDocs;
exports.upsertDocumentChunks = upsertDocumentChunks;
exports.listDocuments = listDocuments;
exports.deleteDocument = deleteDocument;
const pg_1 = require("pg");
const pool = new pg_1.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});
exports.pool = pool;
async function insertTrackedPR(pr) {
    const query = `
    INSERT INTO tracked_prs (pr_url, org, repo, pr_number, channel_id, message_ts, posted_at, eligible_reminder_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (pr_url) DO NOTHING
    RETURNING *
  `;
    const values = [
        pr.pr_url,
        pr.org,
        pr.repo,
        pr.pr_number,
        pr.channel_id,
        pr.message_ts,
        pr.posted_at,
        pr.eligible_reminder_at,
    ];
    const result = await pool.query(query, values);
    return result.rows[0] || null;
}
async function getPendingReminders() {
    const query = `
    SELECT * FROM tracked_prs
    WHERE reminder_sent = FALSE
      AND (is_open = TRUE OR is_open IS NULL)
      AND eligible_reminder_at <= NOW()
    ORDER BY eligible_reminder_at ASC
  `;
    const result = await pool.query(query);
    return result.rows;
}
async function markReminderSent(id) {
    await pool.query('UPDATE tracked_prs SET reminder_sent = TRUE WHERE id = $1', [id]);
}
/**
 * Schedule the next reminder (for recurring reminders).
 * Keeps reminder_sent = FALSE so the PR stays in the pending pool.
 * When nextAt is provided, uses that time (e.g. from getNextReminderEligibleTime for 9-5 PST).
 */
async function scheduleNextReminder(id, nextAt) {
    if (nextAt) {
        await pool.query(`UPDATE tracked_prs SET eligible_reminder_at = $2, reminder_count = COALESCE(reminder_count, 0) + 1 WHERE id = $1`, [id, nextAt]);
    }
    else {
        await pool.query(`UPDATE tracked_prs SET eligible_reminder_at = NOW() + INTERVAL '2 hours', reminder_count = COALESCE(reminder_count, 0) + 1 WHERE id = $1`, [id]);
    }
}
/**
 * Get all open PRs that haven't received reviews yet (for /pr-monitor pending).
 * Unlike getPendingReminders(), this is not gated by eligible_reminder_at or reminder_sent.
 */
async function getOpenUnreviewedPRs() {
    const query = `
    SELECT * FROM tracked_prs
    WHERE (is_open = TRUE OR is_open IS NULL)
      AND (has_reviews = FALSE OR has_reviews IS NULL)
    ORDER BY posted_at ASC
  `;
    const result = await pool.query(query);
    return result.rows;
}
async function markPRClosed(id) {
    await pool.query('UPDATE tracked_prs SET is_open = FALSE WHERE id = $1', [id]);
}
async function getTrackedPRByUrl(prUrl) {
    const result = await pool.query('SELECT * FROM tracked_prs WHERE pr_url = $1', [prUrl]);
    return result.rows[0] || null;
}
// ========== Worker Status Functions ==========
/**
 * Get PRs that need status checking by the worker
 * Returns PRs that:
 * - Are open or unknown (not known to be closed)
 * - Haven't been checked in the last 5 minutes
 */
async function getPRsNeedingStatusCheck() {
    const query = `
    SELECT * FROM tracked_prs
    WHERE (is_open = TRUE OR is_open IS NULL)
      AND (status_checked_at IS NULL OR status_checked_at < NOW() - INTERVAL '5 minutes')
    ORDER BY status_checked_at ASC NULLS FIRST, created_at ASC
    LIMIT 50
  `;
    const result = await pool.query(query);
    return result.rows;
}
/**
 * Update PR status from worker
 */
async function updatePRStatus(prUrl, isOpen, hasReviews) {
    const query = `
    UPDATE tracked_prs 
    SET is_open = $2, 
        has_reviews = $3, 
        status_checked_at = NOW()
    WHERE pr_url = $1
  `;
    await pool.query(query, [prUrl, isOpen, hasReviews]);
}
// ========== Monitored Channels Functions ==========
/**
 * Add a channel to monitoring
 */
async function addMonitoredChannel(channelId, channelName, addedBy) {
    const query = `
    INSERT INTO monitored_channels (channel_id, channel_name, added_by)
    VALUES ($1, $2, $3)
    ON CONFLICT (channel_id) DO UPDATE SET enabled = TRUE, channel_name = COALESCE($2, monitored_channels.channel_name)
    RETURNING *
  `;
    const result = await pool.query(query, [channelId, channelName, addedBy]);
    return result.rows[0] || null;
}
/**
 * Remove a channel from monitoring (soft delete - sets enabled = false)
 */
async function removeMonitoredChannel(channelId) {
    const result = await pool.query('UPDATE monitored_channels SET enabled = FALSE WHERE channel_id = $1', [channelId]);
    return (result.rowCount || 0) > 0;
}
/**
 * Get all enabled monitored channels
 */
async function getMonitoredChannels() {
    const result = await pool.query('SELECT * FROM monitored_channels WHERE enabled = TRUE ORDER BY added_at ASC');
    return result.rows;
}
/**
 * Check if a channel is being monitored
 */
async function isChannelMonitored(channelId) {
    const result = await pool.query('SELECT 1 FROM monitored_channels WHERE channel_id = $1 AND enabled = TRUE', [channelId]);
    return result.rows.length > 0;
}
async function getReviewStats() {
    const total = await pool.query('SELECT COUNT(*) as count FROM tracked_prs');
    const totalTracked = parseInt(total.rows[0].count, 10);
    const reviewedNoReminder = await pool.query(`SELECT COUNT(*) as count FROM tracked_prs WHERE has_reviews = TRUE AND COALESCE(reminder_count, 0) = 0`);
    const reviewedWithoutReminders = parseInt(reviewedNoReminder.rows[0].count, 10);
    const reviewedWithReminder = await pool.query(`SELECT COUNT(*) as count FROM tracked_prs WHERE has_reviews = TRUE AND COALESCE(reminder_count, 0) > 0`);
    const reviewedAfterReminders = parseInt(reviewedWithReminder.rows[0].count, 10);
    const awaiting = await pool.query(`SELECT COUNT(*) as count FROM tracked_prs WHERE (is_open = TRUE OR is_open IS NULL) AND (has_reviews = FALSE OR has_reviews IS NULL)`);
    const stillAwaiting = parseInt(awaiting.rows[0].count, 10);
    const closedResult = await pool.query(`SELECT COUNT(*) as count FROM tracked_prs WHERE is_open = FALSE`);
    const closed = parseInt(closedResult.rows[0].count, 10);
    const breakdown = await pool.query(`
    SELECT
      CASE
        WHEN COALESCE(reminder_count, 0) = 0 THEN '0'
        WHEN reminder_count = 1 THEN '1'
        WHEN reminder_count = 2 THEN '2'
        ELSE '3+'
      END as reminders,
      COUNT(*) as count
    FROM tracked_prs
    GROUP BY 1
    ORDER BY MIN(COALESCE(reminder_count, 0))
  `);
    const reminderBreakdown = breakdown.rows.map((r) => ({
        reminders: r.reminders,
        count: parseInt(r.count, 10),
    }));
    const avgResult = await pool.query(`SELECT COALESCE(AVG(reminder_count), 0) as avg FROM tracked_prs WHERE has_reviews = TRUE AND COALESCE(reminder_count, 0) > 0`);
    const avgRemindersBeforeReview = parseFloat(parseFloat(avgResult.rows[0].avg).toFixed(1));
    return {
        totalTracked,
        reviewedWithoutReminders,
        reviewedAfterReminders,
        stillAwaiting,
        closed,
        reminderBreakdown,
        avgRemindersBeforeReview,
    };
}
// --- PR Reviews ---
async function insertPRReview(review) {
    const query = `
    INSERT INTO pr_reviews (pr_url, pr_number, org, repo, reviewer_login, file_path, diff_hunk, comment_body, review_state, submitted_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `;
    const result = await pool.query(query, [
        review.pr_url, review.pr_number, review.org, review.repo,
        review.reviewer_login, review.file_path, review.diff_hunk,
        review.comment_body, review.review_state, review.submitted_at,
    ]);
    return result.rows[0] || null;
}
async function getPRReviewCount(prUrl) {
    const result = await pool.query('SELECT COUNT(*) as count FROM pr_reviews WHERE pr_url = $1', [prUrl]);
    return parseInt(result.rows[0].count, 10);
}
// --- PR Files ---
async function insertPRFile(file) {
    const query = `
    INSERT INTO pr_files (pr_url, pr_number, org, repo, file_path, change_type, additions, deletions, patch_snippet, author_login)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `;
    const result = await pool.query(query, [
        file.pr_url, file.pr_number, file.org, file.repo,
        file.file_path, file.change_type, file.additions, file.deletions,
        file.patch_snippet, file.author_login,
    ]);
    return result.rows[0] || null;
}
// --- User Mappings ---
async function upsertUserMapping(mapping) {
    const query = `
    INSERT INTO user_mappings (ghe_login, slack_user_id, display_name, email, discovered_via)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (ghe_login) DO UPDATE SET
      slack_user_id = COALESCE($2, user_mappings.slack_user_id),
      display_name = COALESCE($3, user_mappings.display_name),
      email = COALESCE($4, user_mappings.email),
      discovered_via = $5,
      updated_at = NOW()
    RETURNING *
  `;
    const result = await pool.query(query, [
        mapping.ghe_login, mapping.slack_user_id, mapping.display_name,
        mapping.email, mapping.discovered_via,
    ]);
    return result.rows[0] || null;
}
async function getUserMapping(gheLogin) {
    const result = await pool.query('SELECT * FROM user_mappings WHERE ghe_login = $1', [gheLogin]);
    return result.rows[0] || null;
}
async function getAllUserMappings() {
    const result = await pool.query('SELECT * FROM user_mappings ORDER BY ghe_login');
    return result.rows;
}
// --- Harvest State ---
async function getHarvestState(org, repo) {
    const result = await pool.query('SELECT * FROM harvest_state WHERE org = $1 AND repo = $2', [org, repo]);
    return result.rows[0] || null;
}
async function upsertHarvestState(org, repo, lastPrNumber) {
    await pool.query(`
    INSERT INTO harvest_state (org, repo, last_harvested_pr_number, last_harvested_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (org, repo) DO UPDATE SET
      last_harvested_pr_number = $3,
      last_harvested_at = NOW()
  `, [org, repo, lastPrNumber]);
}
async function upsertRepoHarvestState(org, repo, sha) {
    await pool.query(`
    INSERT INTO harvest_state (org, repo, last_repo_harvest_sha, last_repo_harvested_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (org, repo) DO UPDATE SET
      last_repo_harvest_sha = $3,
      last_repo_harvested_at = NOW()
  `, [org, repo, sha]);
}
// --- Repo Knowledge ---
async function upsertRepoKnowledge(chunk) {
    const result = await pool.query(`
    INSERT INTO repo_knowledge (org, repo, file_path, content_chunk, chunk_index, last_commit_sha)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT DO NOTHING
    RETURNING id
  `, [chunk.org, chunk.repo, chunk.file_path, chunk.content_chunk, chunk.chunk_index, chunk.last_commit_sha]);
    return result.rows[0]?.id || 0;
}
async function deleteRepoKnowledgeForFile(org, repo, filePath) {
    await pool.query('DELETE FROM repo_knowledge WHERE org = $1 AND repo = $2 AND file_path = $3', [org, repo, filePath]);
}
// --- Embeddings ---
async function insertEmbedding(contentType, sourceId, contentText, embedding, metadata = {}) {
    const result = await pool.query(`
    INSERT INTO pr_embeddings (content_type, source_id, content_text, embedding, metadata)
    VALUES ($1, $2, $3, $4::vector, $5)
    RETURNING id
  `, [contentType, sourceId, contentText, `[${embedding.join(',')}]`, JSON.stringify(metadata)]);
    return result.rows[0]?.id || 0;
}
async function updateRepoKnowledgeEmbedding(id, embedding) {
    await pool.query('UPDATE repo_knowledge SET embedding = $2::vector, updated_at = NOW() WHERE id = $1', [id, `[${embedding.join(',')}]`]);
}
async function getUnembeddedPRReviews(limit = 100) {
    const result = await pool.query(`
    SELECT r.* FROM pr_reviews r
    LEFT JOIN pr_embeddings e ON e.content_type = 'pr_review' AND e.source_id = r.id
    WHERE e.id IS NULL
    ORDER BY r.id ASC
    LIMIT $1
  `, [limit]);
    return result.rows;
}
async function getUnembeddedRepoKnowledge(limit = 100) {
    const result = await pool.query(`
    SELECT * FROM repo_knowledge
    WHERE embedding IS NULL
    ORDER BY id ASC
    LIMIT $1
  `, [limit]);
    return result.rows;
}
// --- Vector Search ---
async function searchSimilarReviews(embedding, topK = 10) {
    const result = await pool.query(`
    SELECT r.*, 1 - (e.embedding <=> $1::vector) as similarity
    FROM pr_embeddings e
    JOIN pr_reviews r ON e.source_id = r.id AND e.content_type = 'pr_review'
    ORDER BY e.embedding <=> $1::vector
    LIMIT $2
  `, [`[${embedding.join(',')}]`, topK]);
    return result.rows;
}
async function searchSimilarCode(embedding, topK = 10) {
    const result = await pool.query(`
    SELECT rk.*, 1 - (rk.embedding <=> $1::vector) as similarity
    FROM repo_knowledge rk
    WHERE rk.embedding IS NOT NULL
    ORDER BY rk.embedding <=> $1::vector
    LIMIT $2
  `, [`[${embedding.join(',')}]`, topK]);
    return result.rows;
}
async function findReviewersByFiles(filePaths, topK = 10) {
    // Extract unique parent directories for fuzzy matching
    const dirs = [...new Set(filePaths.map(f => f.split('/').slice(0, -1).join('/')).filter(d => d.length > 0))];
    const dirPatterns = dirs.map(d => d + '/%');
    const result = await pool.query(`
    SELECT reviewer_login, COUNT(*) as review_count,
           array_agg(DISTINCT file_path) as files
    FROM pr_reviews
    WHERE file_path = ANY($1)
       OR file_path LIKE ANY($3)
    GROUP BY reviewer_login
    ORDER BY review_count DESC
    LIMIT $2
  `, [filePaths, topK, dirPatterns]);
    return result.rows;
}
async function findCodeTouchersByFiles(filePaths, topK = 10) {
    // Extract unique parent directories for fuzzy matching
    const dirs = [...new Set(filePaths.map(f => f.split('/').slice(0, -1).join('/')).filter(d => d.length > 0))];
    const dirPatterns = dirs.map(d => d + '/%');
    const result = await pool.query(`
    SELECT author_login, COUNT(*) as change_count,
           array_agg(DISTINCT file_path) as files
    FROM pr_files
    WHERE (file_path = ANY($1) OR file_path LIKE ANY($3)) AND author_login IS NOT NULL
    GROUP BY author_login
    ORDER BY change_count DESC
    LIMIT $2
  `, [filePaths, topK, dirPatterns]);
    return result.rows;
}
async function getDistinctRepos() {
    const result = await pool.query('SELECT DISTINCT org, repo FROM tracked_prs ORDER BY org, repo');
    return result.rows;
}
// ---------------------------------------------------------------------------
// AI Review Feedback (manual 👍/👎 from Slack)
// ---------------------------------------------------------------------------
async function insertOrUpdateFeedback(prUrl, userId, rating, feedbackText) {
    await pool.query(`
    INSERT INTO ai_review_feedback (pr_url, user_id, rating, feedback_text, created_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (pr_url, user_id) DO UPDATE SET
      rating = $3, feedback_text = COALESCE($4, ai_review_feedback.feedback_text), created_at = NOW()
  `, [prUrl, userId, rating, feedbackText || null]);
}
async function getRecentFeedback(limit = 5) {
    const result = await pool.query(`
    SELECT f.pr_url, f.rating, f.feedback_text, ar.review_json
    FROM ai_review_feedback f
    LEFT JOIN pr_analysis_results ar ON f.pr_url = ar.pr_url
    WHERE f.feedback_text IS NOT NULL AND f.feedback_text != ''
    ORDER BY f.created_at DESC
    LIMIT $1
  `, [limit]);
    return result.rows;
}
// ---------------------------------------------------------------------------
// Per-Comment AI Feedback (👍/👎 on individual suggestions)
// ---------------------------------------------------------------------------
async function insertOrUpdateCommentFeedback(prUrl, commentIndex, userId, rating, commentSnapshot) {
    await pool.query(`
    INSERT INTO ai_comment_feedback (pr_url, comment_index, user_id, rating, comment_snapshot, created_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (pr_url, comment_index, user_id) DO UPDATE SET
      rating = $4, created_at = NOW()
  `, [prUrl, commentIndex, userId, rating, commentSnapshot ? JSON.stringify(commentSnapshot) : null]);
}
async function getCommentFeedbackStats(prUrl) {
    const result = await pool.query(`
    SELECT comment_index,
           COUNT(*) FILTER (WHERE rating = 'helpful') AS helpful,
           COUNT(*) FILTER (WHERE rating = 'not_helpful') AS not_helpful
    FROM ai_comment_feedback
    WHERE pr_url = $1
    GROUP BY comment_index
    ORDER BY comment_index
  `, [prUrl]);
    return result.rows;
}
// ---------------------------------------------------------------------------
// AI Review Lessons (automated post-merge comparison)
// ---------------------------------------------------------------------------
async function insertReviewLessons(prUrl, aiReview, peerComments, lessons, embedding) {
    if (embedding && embedding.length > 0) {
        const embeddingStr = `[${embedding.join(',')}]`;
        await pool.query(`
      INSERT INTO ai_review_lessons (pr_url, ai_review_json, peer_comments_json, lessons_json, embedding, created_at)
      VALUES ($1, $2, $3, $4, $5::vector, NOW())
      ON CONFLICT (pr_url) DO UPDATE SET
        ai_review_json = $2, peer_comments_json = $3, lessons_json = $4, embedding = $5::vector, created_at = NOW()
    `, [prUrl, JSON.stringify(aiReview), JSON.stringify(peerComments), JSON.stringify(lessons), embeddingStr]);
    }
    else {
        await pool.query(`
      INSERT INTO ai_review_lessons (pr_url, ai_review_json, peer_comments_json, lessons_json, created_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (pr_url) DO UPDATE SET
        ai_review_json = $2, peer_comments_json = $3, lessons_json = $4, created_at = NOW()
    `, [prUrl, JSON.stringify(aiReview), JSON.stringify(peerComments), JSON.stringify(lessons)]);
    }
}
async function getRecentLessons(limit = 3) {
    const result = await pool.query(`
    SELECT pr_url, lessons_json, created_at
    FROM ai_review_lessons
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);
    return result.rows;
}
async function getSimilarLessons(embedding, limit = 5) {
    const embeddingStr = `[${embedding.join(',')}]`;
    const result = await pool.query(`
    SELECT pr_url, lessons_json, created_at,
           1 - (embedding <=> $1::vector) AS similarity
    FROM ai_review_lessons
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `, [embeddingStr, limit]);
    return result.rows;
}
async function getPRsNeedingLessonExtraction() {
    const result = await pool.query(`
    SELECT ar.pr_url, ar.review_json, tp.org, tp.repo, tp.pr_number
    FROM pr_analysis_results ar
    JOIN tracked_prs tp ON ar.pr_url = tp.pr_url
    LEFT JOIN ai_review_lessons al ON ar.pr_url = al.pr_url
    WHERE tp.is_open = FALSE
      AND al.id IS NULL
    ORDER BY ar.created_at DESC
    LIMIT 20
  `);
    return result.rows;
}
// --- Team Documents (design docs, requirements) ---
async function searchSimilarDocs(embedding, topK = 3) {
    const embeddingStr = `[${embedding.join(',')}]`;
    const result = await pool.query(`
    SELECT id, title, source_url, doc_type, content_chunk, chunk_index,
           1 - (embedding <=> $1::vector) AS similarity
    FROM team_documents
    WHERE embedding IS NOT NULL
    ORDER BY embedding <=> $1::vector
    LIMIT $2
  `, [embeddingStr, topK]);
    return result.rows;
}
async function upsertDocumentChunks(sourceUrl, title, docType, chunks) {
    // Delete old chunks for this doc
    await pool.query('DELETE FROM team_documents WHERE source_url = $1', [sourceUrl]);
    let inserted = 0;
    for (let i = 0; i < chunks.length; i++) {
        const embeddingStr = `[${chunks[i].embedding.join(',')}]`;
        await pool.query(`
      INSERT INTO team_documents (title, source_url, doc_type, content_chunk, chunk_index, embedding, last_fetched_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6::vector, NOW(), NOW(), NOW())
    `, [title, sourceUrl, docType, chunks[i].content, i, embeddingStr]);
        inserted++;
    }
    return inserted;
}
async function listDocuments() {
    const result = await pool.query(`
    SELECT source_url, title, doc_type,
           COUNT(*) AS chunk_count,
           MIN(created_at) AS created_at,
           MAX(last_fetched_at) AS last_fetched_at
    FROM team_documents
    GROUP BY source_url, title, doc_type
    ORDER BY MAX(created_at) DESC
  `);
    return result.rows;
}
async function deleteDocument(sourceUrl) {
    const result = await pool.query('DELETE FROM team_documents WHERE source_url = $1', [sourceUrl]);
    return result.rowCount || 0;
}
//# sourceMappingURL=client.js.map