#!/usr/bin/env npx ts-node
/**
 * Complete backfill script that processes ALL repo_knowledge rows in batches
 *
 * Usage:
 *   npx tsx worker/backfillDomainMetadataComplete.ts
 */

import 'dotenv/config';
import { pool } from '../src/db/client';
import { minimatch } from 'minimatch';

interface DomainMapping {
  domain_id: number;
  file_pattern: string;
  priority: number;
}

function extractCodeElementInfo(content: string, filePath: string): {
  type: string;
  name: string | null;
} {
  // Simple heuristics to extract element type and name

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

async function backfillDomainMetadata(): Promise<void> {
  console.log('Starting COMPLETE domain metadata backfill...');

  // Fetch all domain_file_mappings
  const mappingsResult = await pool.query(`
    SELECT domain_id, file_pattern, priority
    FROM domain_file_mappings
    ORDER BY priority DESC
  `);
  const mappings: DomainMapping[] = mappingsResult.rows;
  console.log(`Loaded ${mappings.length} domain file mappings`);

  // Count total chunks to process (unprocessed = no code_element_type yet)
  const countResult = await pool.query(`
    SELECT COUNT(*) as total
    FROM repo_knowledge
    WHERE code_element_type IS NULL
  `);
  const totalChunks = parseInt(countResult.rows[0].total, 10);
  console.log(`Found ${totalChunks} total chunks to backfill`);

  if (totalChunks === 0) {
    console.log('No chunks to backfill. Exiting.');
    return;
  }

  const BATCH_SIZE = 5000;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let batchNum = 0;

  while (true) {
    // Fetch next batch (unprocessed = no code_element_type yet)
    const chunksResult = await pool.query(`
      SELECT id, file_path, content_chunk
      FROM repo_knowledge
      WHERE code_element_type IS NULL
      ORDER BY id
      LIMIT $1
    `, [BATCH_SIZE]);

    const chunks = chunksResult.rows;
    if (chunks.length === 0) {
      console.log('No more chunks to process.');
      break;
    }

    batchNum++;
    console.log(`\nProcessing batch #${batchNum}: ${chunks.length} chunks`);

    let batchUpdated = 0;
    let batchSkipped = 0;

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

      // Always update ALL records (even if domain_id=null and type=unknown)
      // This marks them as "processed" so they won't be selected again
      try {
        await pool.query(`
          UPDATE repo_knowledge
          SET domain_id = $1, code_element_type = $2, code_element_name = $3, updated_at = NOW()
          WHERE id = $4
        `, [domainId, type, name, chunk.id]);

        if (domainId !== null || type !== 'unknown') {
          batchUpdated++;
        } else {
          batchSkipped++;
        }
      } catch (error: any) {
        console.error(`Error updating chunk ${chunk.id}:`, error.message);
        batchSkipped++;
      }

      // Progress within batch every 500 chunks
      if ((batchUpdated + batchSkipped) % 500 === 0) {
        console.log(`  Batch progress: ${batchUpdated} updated, ${batchSkipped} skipped (${batchUpdated + batchSkipped}/${chunks.length})`);
      }
    }

    totalUpdated += batchUpdated;
    totalSkipped += batchSkipped;

    console.log(`Batch #${batchNum} complete: ${batchUpdated} updated, ${batchSkipped} skipped`);
    console.log(`Total so far: ${totalUpdated} updated, ${totalSkipped} skipped (${totalUpdated + totalSkipped}/${totalChunks})`);
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('Backfill complete!');
  console.log(`  Total updated: ${totalUpdated} chunks`);
  console.log(`  Total skipped: ${totalSkipped} chunks (no domain match or unknown type)`);
  console.log(`  Total processed: ${totalUpdated + totalSkipped}`);
  console.log('='.repeat(60));
}

backfillDomainMetadata()
  .then(() => {
    console.log('Script finished successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
