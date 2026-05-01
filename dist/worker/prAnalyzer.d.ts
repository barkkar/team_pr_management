#!/usr/bin/env npx ts-node
/**
 * PR Analyzer
 *
 * Analyzes a single PR using Claude AI:
 *   1. Fetches PR diff + changed files from GHE
 *   2. Resolves domain-scoped code examples via ontology engine
 *   3. Calls Claude AI to generate review comments (3-pass)
 *   4. Identifies suggested reviewers
 *   5. Reports results back to Heroku for Slack posting
 *
 * Can be run standalone:
 *   npm run analyze-pr -- --pr-url <url>
 *
 * Or triggered by the polling loop in prAnalyzerLoop.
 */
import 'dotenv/config';
//# sourceMappingURL=prAnalyzer.d.ts.map