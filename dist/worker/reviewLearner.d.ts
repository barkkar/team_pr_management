#!/usr/bin/env npx ts-node
/**
 * Review Learner Worker
 *
 * After a PR is closed/merged, compares the AI review with actual peer review
 * comments and uses the LLM to generate structured lessons for improving
 * future AI reviews.
 *
 * Usage:
 *   npm run review-learn              # Run once
 *   npm run review-learn:watch        # Run every 10 minutes
 */
import 'dotenv/config';
//# sourceMappingURL=reviewLearner.d.ts.map