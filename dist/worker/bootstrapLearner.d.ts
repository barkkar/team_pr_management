#!/usr/bin/env npx ts-node
/**
 * Bootstrap Learner
 *
 * Batch processes all closed tracked PRs for learning:
 *   1. Fetches PR details, diff, files from GHE
 *   2. Fetches learning context from past lessons/feedback
 *   3. Generates AI review via Claude (with learning context)
 *   4. Stores AI review in pr_analysis_results
 *   5. Fetches peer review comments from GHE
 *   6. Compares AI vs peer via LLM → structured lessons
 *   7. Stores lessons in ai_review_lessons
 *
 * Usage:
 *   npm run bootstrap-learn              # Process all (default limit: 50)
 *   npm run bootstrap-learn -- --limit 10
 */
import 'dotenv/config';
//# sourceMappingURL=bootstrapLearner.d.ts.map