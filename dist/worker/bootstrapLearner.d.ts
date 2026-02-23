#!/usr/bin/env npx ts-node
/**
 * Bootstrap Learner
 *
 * Batch processes all closed tracked PRs through the full RAG pipeline:
 *   1. Fetches PR details, diff, files from GHE
 *   2. Generates embeddings via nomic-embed-text
 *   3. Vector search for similar reviews + codebase context
 *   4. Fetches learning context from past lessons/feedback
 *   5. Generates AI review via Ollama LLM (full RAG prompt)
 *   6. Stores AI review in pr_analysis_results
 *   7. Fetches peer review comments from GHE
 *   8. Compares AI vs peer via LLM → structured lessons
 *   9. Stores lessons in ai_review_lessons
 *
 * Usage:
 *   npm run bootstrap-learn              # Process all (default limit: 50)
 *   npm run bootstrap-learn -- --limit 10
 */
import 'dotenv/config';
//# sourceMappingURL=bootstrapLearner.d.ts.map