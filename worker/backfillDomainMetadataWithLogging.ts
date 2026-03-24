#!/usr/bin/env npx ts-node
/**
 * Enhanced backfill script with detailed logging of skipped files
 *
 * Usage:
 *   npx tsx worker/backfillDomainMetadataWithLogging.ts
 */

import 'dotenv/config';
import { pool } from '../src/db/client';
import { minimatch } from 'minimatch';
import * as fs from 'fs';

interface DomainMapping {
  domain_id: number;
  file_pattern: string;
  priority: number;
}

interface SkipReason {
  file_path: string;
  reason: 'no_domain_match' | 'unknown_type';
  content_preview: string;
}

function extractCodeElementInfo(content: string, filePath: string): {
  type: string;
  name: string | null;
} {
  // Test files
  if (/Test\.(java|ts|js|py)$/.test(filePath) || /\.test\.(ts|js)$/.test(filePath) || /\.spec\.(ts|js)$/.test(filePath)) {
    const match = content.match(/(?:class|function|def)\s+(\w+Test)/);
    return { type: 'test', name: match?.[1] || null };
  }

  // Java/TypeScript classes
  const classMatch = content.match(/(?:public|export)?\s*class\s+(\w+)/);
  if (classMatch) {
    return { type: 'class', name: classMatch[1] };
  }

  // Java/TypeScript interfaces
  const interfaceMatch = content.match(/(?:export)?\s*interface\s+(\w+)/);
  if (interfaceMatch) {
    return { type: 'interface', name: interfaceMatch[1] };
  }

  // Functions (JavaScript/TypeScript/Python)
  const functionMatch = content.match(/(?:export\s+)?(?:function|def)\s+(\w+)/);
  if (functionMatch) {
    return { type: 'function', name: functionMatch[1] };
  }

  // Configuration files
  if (/\.(config|conf|yaml|yml|json)$/.test(filePath)) {
    return { type: 'config', name: null };
  }

  return { type: 'unknown', name: null };
}

async function backfillWithLogging(): Promise<void> {
  console.log('Starting domain metadata backfill with logging...');

  // Fetch all domain_file_mappings
  const mappingsResult = await pool.query(`
    SELECT domain_id, file_pattern, priority
    FROM domain_file_mappings
    ORDER BY priority DESC
  `);
  const mappings: DomainMapping[] = mappingsResult.rows;
  console.log(`Loaded ${mappings.length} domain file mappings`);

  // Fetch all repo_knowledge rows without domain_id
  const chunksResult = await pool.query(`
    SELECT id, file_path, content_chunk
    FROM repo_knowledge
    WHERE domain_id IS NULL
    ORDER BY id
    LIMIT 10000
  `);
  const chunks = chunksResult.rows;
  console.log(`Found ${chunks.length} chunks to backfill`);

  if (chunks.length === 0) {
    console.log('No chunks to backfill. Exiting.');
    return;
  }

  let updated = 0;
  let skippedNoDomain = 0;
  let skippedUnknownType = 0;
  const skipReasons: SkipReason[] = [];

  for (const chunk of chunks) {
    // Find matching domain
    let domainId: number | null = null;
    for (const mapping of mappings) {
      if (minimatch(chunk.file_path, mapping.file_pattern)) {
        domainId = mapping.domain_id;
        break;
      }
    }

    // Extract element info
    const { type, name } = extractCodeElementInfo(chunk.content_chunk, chunk.file_path);

    // Track skip reasons
    if (domainId === null) {
      skippedNoDomain++;
      if (skipReasons.length < 100) { // Keep first 100 examples
        skipReasons.push({
          file_path: chunk.file_path,
          reason: 'no_domain_match',
          content_preview: chunk.content_chunk.substring(0, 150),
        });
      }
    }

    if (type === 'unknown' && domainId !== null) {
      skippedUnknownType++;
      if (skipReasons.length < 100) {
        skipReasons.push({
          file_path: chunk.file_path,
          reason: 'unknown_type',
          content_preview: chunk.content_chunk.substring(0, 150),
        });
      }
    }

    // Update row if we have at least domain_id or element type
    if (domainId !== null || type !== 'unknown') {
      try {
        await pool.query(`
          UPDATE repo_knowledge
          SET domain_id = $1, code_element_type = $2, code_element_name = $3, updated_at = NOW()
          WHERE id = $4
        `, [domainId, type, name, chunk.id]);
        updated++;
      } catch (error: any) {
        console.error(`Error updating chunk ${chunk.id}:`, error.message);
      }
    }

    // Progress update every 100 chunks
    if ((updated + skippedNoDomain + skippedUnknownType) % 100 === 0) {
      console.log(`Progress: ${updated} updated, ${skippedNoDomain + skippedUnknownType} skipped (${updated + skippedNoDomain + skippedUnknownType}/${chunks.length})`);
    }
  }

  console.log('');
  console.log('Backfill complete!');
  console.log(`  Updated: ${updated} chunks`);
  console.log(`  Skipped (no domain): ${skippedNoDomain} chunks`);
  console.log(`  Skipped (unknown type): ${skippedUnknownType} chunks`);
  console.log(`  Total processed: ${chunks.length}`);

  // Write skip reasons to file
  if (skipReasons.length > 0) {
    const logPath = '/tmp/backfill_skipped.json';
    fs.writeFileSync(logPath, JSON.stringify(skipReasons, null, 2));
    console.log(`\nSkipped file examples written to: ${logPath}`);
    console.log('You can analyze this file to see which files didn\'t match any domain patterns.');
  }

  // Print file pattern summary
  console.log('\nFile patterns without domain match:');
  const noDomainFiles = skipReasons
    .filter(r => r.reason === 'no_domain_match')
    .map(r => r.file_path);
  const patternCounts = new Map<string, number>();

  for (const filePath of noDomainFiles) {
    const ext = filePath.split('.').pop() || 'no-extension';
    patternCounts.set(ext, (patternCounts.get(ext) || 0) + 1);
  }

  const sortedPatterns = Array.from(patternCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  for (const [ext, count] of sortedPatterns) {
    console.log(`  *.${ext}: ${count} files`);
  }
}

backfillWithLogging()
  .then(() => {
    console.log('\nScript finished successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
