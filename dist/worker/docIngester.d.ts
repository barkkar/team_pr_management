#!/usr/bin/env npx ts-node
/**
 * Document Ingester
 *
 * Fetches Google Docs via shared links, chunks the content,
 * generates embeddings, and stores them for AI review context.
 *
 * Usage:
 *   npm run ingest-doc -- <google-drive-shared-url> --title "Doc Name" [--type design|requirements|runbook]
 *   npm run ingest-doc -- --list
 *   npm run ingest-doc -- --delete <google-drive-shared-url>
 */
import 'dotenv/config';
//# sourceMappingURL=docIngester.d.ts.map