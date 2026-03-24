#!/usr/bin/env npx ts-node
/**
 * One-time script to backfill domain_id and code_element_type for existing repo_knowledge rows
 *
 * Usage:
 *   npx tsx worker/backfillDomainMetadata.ts
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
  console.log('Starting domain metadata backfill...');

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
  let skipped = 0;

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

    // Update row only if we have at least domain_id or element type
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
        skipped++;
      }
    } else {
      skipped++;
    }

    // Progress update every 100 chunks
    if ((updated + skipped) % 100 === 0) {
      console.log(`Progress: ${updated} updated, ${skipped} skipped (${updated + skipped}/${chunks.length})`);
    }
  }

  console.log('');
  console.log('Backfill complete!');
  console.log(`  Updated: ${updated} chunks`);
  console.log(`  Skipped: ${skipped} chunks (no domain match or unknown type)`);
  console.log(`  Total processed: ${updated + skipped}`);
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
