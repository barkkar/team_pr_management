#!/usr/bin/env npx ts-node
/**
 * Document Ingester
 *
 * Fetches Google Docs via shared links, chunks the content,
 * generates embeddings, and stores them for AI review context.
 *
 * Usage:
 *   npm run ingest-doc -- --dir ./path/to/skills [--type codebase-knowledge]
 *   npm run ingest-doc -- --file ./path/to/doc.txt --title "Doc Name" [--type design|requirements|runbook]
 *   npm run ingest-doc -- <google-drive-shared-url> --title "Doc Name" [--type design|requirements|runbook]
 *   npm run ingest-doc -- --list
 *   npm run ingest-doc -- --delete <source-identifier>
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { Ollama } from 'ollama';

const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [DocIngester] ${message}`);
}

function logError(message: string): void {
  console.error(`[${new Date().toISOString()}] [DocIngester] ${message}`);
}

function herokuHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Worker-API-Key': WORKER_API_KEY! };
}

// ---------------------------------------------------------------------------
// Ollama embedding
// ---------------------------------------------------------------------------

let ollama: Ollama | null = null;
function getOllama(): Ollama {
  if (!ollama) ollama = new Ollama({ host: OLLAMA_HOST });
  return ollama;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const client = getOllama();
  const truncated = text.substring(0, 2000);
  const response = await client.embed({ model: OLLAMA_EMBED_MODEL, input: truncated });
  return response.embeddings[0];
}

// ---------------------------------------------------------------------------
// Google Drive helpers
// ---------------------------------------------------------------------------

/**
 * Extract the Google Doc ID from various URL formats:
 * - https://docs.google.com/document/d/{docId}/edit
 * - https://docs.google.com/document/d/{docId}/edit?usp=sharing
 * - https://drive.google.com/file/d/{docId}/view
 * - https://drive.google.com/open?id={docId}
 */
function extractDocId(url: string): string | null {
  // /d/{docId}/ pattern
  const dMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (dMatch) return dMatch[1];

  // ?id={docId} pattern
  const idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idMatch) return idMatch[1];

  return null;
}

/**
 * Fetch Google Doc content as plain text.
 * The doc must be shared as "Anyone with the link can view".
 */
async function fetchGoogleDocText(docId: string): Promise<string> {
  const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
  const response = await axios.get(exportUrl, {
    timeout: 30000,
    maxRedirects: 5,
    responseType: 'text',
  });
  return response.data;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/**
 * Split text into overlapping chunks of ~chunkSize characters.
 * Tries to break at paragraph boundaries.
 */
function chunkText(text: string, chunkSize: number = 1500, overlap: number = 200): string[] {
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      // Keep overlap from the end of the current chunk
      const words = current.split(/\s+/);
      const overlapWords = words.slice(-Math.ceil(overlap / 5));
      current = overlapWords.join(' ') + '\n\n' + para;
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function ingestDoc(url: string, title: string, docType: string): Promise<void> {
  log(`Ingesting: "${title}" (${docType})`);
  log(`  URL: ${url}`);

  // 1. Extract doc ID
  const docId = extractDocId(url);
  if (!docId) {
    logError('Could not extract Google Doc ID from URL.');
    logError('Supported formats:');
    logError('  https://docs.google.com/document/d/{docId}/edit');
    logError('  https://drive.google.com/file/d/{docId}/view');
    process.exit(1);
  }
  log(`  Doc ID: ${docId}`);

  // 2. Fetch content
  log('  Fetching document content...');
  let content: string;
  try {
    content = await fetchGoogleDocText(docId);
  } catch (error: any) {
    logError(`Failed to fetch document: ${error.message}`);
    logError('Make sure the doc is shared as "Anyone with the link can view".');
    process.exit(1);
  }
  log(`  Fetched ${content.length} characters`);

  if (content.length < 50) {
    logError('Document content is too short (< 50 chars). Is it shared correctly?');
    process.exit(1);
  }

  // 3. Chunk
  log('  Chunking content...');
  const textChunks = chunkText(content);
  log(`  Created ${textChunks.length} chunks`);

  // 4. Embed each chunk
  log('  Generating embeddings...');
  const chunks: { content: string; embedding: number[] }[] = [];
  for (let i = 0; i < textChunks.length; i++) {
    const embedding = await generateEmbedding(textChunks[i]);
    chunks.push({ content: textChunks[i], embedding });
    if ((i + 1) % 5 === 0) {
      log(`    Embedded ${i + 1}/${textChunks.length} chunks`);
    }
  }
  log(`  All ${chunks.length} chunks embedded`);

  // 5. Store via Heroku API
  log('  Storing in database...');
  const response = await axios.post(
    `${HEROKU_API_URL}/api/team-documents`,
    { source_url: url, title, doc_type: docType, chunks },
    { headers: herokuHeaders(), timeout: 60000 },
  );
  log(`  ✅ Stored ${response.data.chunks_stored} chunks for "${title}"`);
}

async function ingestFromFile(filePath: string, title: string, docType: string): Promise<void> {
  const resolved = path.resolve(filePath);
  log(`Ingesting from file: "${title}" (${docType})`);
  log(`  File: ${resolved}`);

  if (!fs.existsSync(resolved)) {
    logError(`File not found: ${resolved}`);
    process.exit(1);
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  log(`  Read ${content.length} characters`);

  if (content.length < 50) {
    logError('File content is too short (< 50 chars).');
    process.exit(1);
  }

  // Chunk
  log('  Chunking content...');
  const textChunks = chunkText(content);
  log(`  Created ${textChunks.length} chunks`);

  // Embed each chunk
  log('  Generating embeddings...');
  const chunks: { content: string; embedding: number[] }[] = [];
  for (let i = 0; i < textChunks.length; i++) {
    const embedding = await generateEmbedding(textChunks[i]);
    chunks.push({ content: textChunks[i], embedding });
    if ((i + 1) % 5 === 0) {
      log(`    Embedded ${i + 1}/${textChunks.length} chunks`);
    }
  }
  log(`  All ${chunks.length} chunks embedded`);

  // Use the file path as the source identifier
  const sourceId = `file://${resolved}`;

  // Store via Heroku API
  log('  Storing in database...');
  const response = await axios.post(
    `${HEROKU_API_URL}/api/team-documents`,
    { source_url: sourceId, title, doc_type: docType, chunks },
    { headers: herokuHeaders(), timeout: 60000 },
  );
  log(`  ✅ Stored ${response.data.chunks_stored} chunks for "${title}"`);
}

function findMdFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden dirs like .git
      if (!entry.name.startsWith('.')) {
        results.push(...findMdFiles(fullPath));
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath);
    }
  }
  return results;
}

async function ingestFromDir(dirPath: string, docType: string): Promise<void> {
  const resolved = path.resolve(dirPath);
  log(`Ingesting directory: ${resolved}`);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    logError(`Not a directory: ${resolved}`);
    process.exit(1);
  }

  const mdFiles = findMdFiles(resolved);
  log(`Found ${mdFiles.length} .md file(s)`);

  if (mdFiles.length === 0) {
    logError('No .md files found in directory.');
    process.exit(1);
  }

  let ingested = 0;
  let skipped = 0;

  for (let i = 0; i < mdFiles.length; i++) {
    const filePath = mdFiles[i];
    const relativePath = path.relative(resolved, filePath);
    const content = fs.readFileSync(filePath, 'utf-8');

    if (content.length < 50) {
      log(`  [${i + 1}/${mdFiles.length}] Skipping ${relativePath} (${content.length} chars — too short)`);
      skipped++;
      continue;
    }

    log(`  [${i + 1}/${mdFiles.length}] Ingesting ${relativePath} (${content.length} chars)...`);

    const textChunks = chunkText(content);
    const chunks: { content: string; embedding: number[] }[] = [];
    for (const chunk of textChunks) {
      const embedding = await generateEmbedding(chunk);
      chunks.push({ content: chunk, embedding });
    }

    const sourceId = `file://${path.resolve(filePath)}`;
    try {
      const response = await axios.post(
        `${HEROKU_API_URL}/api/team-documents`,
        { source_url: sourceId, title: relativePath, doc_type: docType, chunks },
        { headers: herokuHeaders(), timeout: 60000 },
      );
      log(`    ✅ ${chunks.length} chunks stored`);
      ingested++;
    } catch (error: any) {
      logError(`    ❌ Failed to store: ${error.message}`);
    }
  }

  log(`Done! Ingested: ${ingested}, Skipped: ${skipped}, Total: ${mdFiles.length}`);
}

async function listDocs(): Promise<void> {
  const response = await axios.get(
    `${HEROKU_API_URL}/api/team-documents`,
    { headers: herokuHeaders(), timeout: 15000 },
  );
  const docs = response.data.docs || [];
  if (docs.length === 0) {
    log('No documents registered.');
    return;
  }
  log(`${docs.length} document(s):\n`);
  for (const doc of docs) {
    console.log(`  📄 ${doc.title}`);
    console.log(`     Type: ${doc.doc_type} | Chunks: ${doc.chunk_count}`);
    console.log(`     URL: ${doc.source_url}`);
    console.log(`     Last fetched: ${doc.last_fetched_at || 'never'}`);
    console.log('');
  }
}

async function deleteDoc(url: string): Promise<void> {
  const response = await axios.delete(
    `${HEROKU_API_URL}/api/team-documents`,
    { data: { source_url: url }, headers: herokuHeaders(), timeout: 15000 },
  );
  log(`Deleted ${response.data.chunks_deleted} chunks for "${url}"`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  log('='.repeat(60));
  log('Document Ingester');
  log('='.repeat(60));

  if (!HEROKU_API_URL || !WORKER_API_KEY) {
    logError('HEROKU_API_URL and WORKER_API_KEY are required');
    process.exit(1);
  }

  const args = process.argv.slice(2);

  // --list
  if (args.includes('--list')) {
    await listDocs();
    return;
  }

  // --delete <url>
  const deleteIdx = args.indexOf('--delete');
  if (deleteIdx >= 0) {
    const url = args[deleteIdx + 1];
    if (!url) {
      logError('Usage: npm run ingest-doc -- --delete <url>');
      process.exit(1);
    }
    await deleteDoc(url);
    return;
  }

  // Common args
  const titleIdx = args.indexOf('--title');
  const title = titleIdx >= 0 ? args[titleIdx + 1] : 'Untitled Document';

  const typeIdx = args.indexOf('--type');
  const docType = typeIdx >= 0 ? args[typeIdx + 1] : 'design';

  // Verify Ollama before any ingest
  const fileIdx = args.indexOf('--file');
  const url = args.find(a => a.startsWith('https://'));

  const dirIdx = args.indexOf('--dir');

  if (fileIdx < 0 && dirIdx < 0 && !url) {
    logError('Usage:');
    logError('  npm run ingest-doc -- --dir ./skills-repo/skills [--type codebase-knowledge]');
    logError('  npm run ingest-doc -- --file ./doc.txt --title "Doc Name" [--type design|requirements|runbook]');
    logError('  npm run ingest-doc -- <google-drive-url> --title "Doc Name" [--type design|requirements|runbook]');
    logError('  npm run ingest-doc -- --list');
    logError('  npm run ingest-doc -- --delete <source-identifier>');
    process.exit(1);
  }

  try {
    const client = getOllama();
    await client.embed({ model: OLLAMA_EMBED_MODEL, input: 'test' });
    log(`Ollama embedding model ready: ${OLLAMA_EMBED_MODEL}`);
  } catch (error: any) {
    logError(`Ollama not ready: ${error.message}`);
    logError(`Run: ollama pull ${OLLAMA_EMBED_MODEL}`);
    process.exit(1);
  }

  // --dir recursive .md ingestion
  if (dirIdx >= 0) {
    const dirPath = args[dirIdx + 1];
    if (!dirPath) {
      logError('Usage: npm run ingest-doc -- --dir ./path/to/skills [--type codebase-knowledge]');
      process.exit(1);
    }
    await ingestFromDir(dirPath, docType);
    return;
  }

  // --file local ingestion
  if (fileIdx >= 0) {
    const filePath = args[fileIdx + 1];
    if (!filePath) {
      logError('Usage: npm run ingest-doc -- --file ./doc.txt --title "Doc Name"');
      process.exit(1);
    }
    await ingestFromFile(filePath, title, docType);
    return;
  }

  // URL-based ingestion (Google Docs)
  await ingestDoc(url!, title, docType);
}

run().then(() => process.exit(0)).catch((error) => {
  logError(`Fatal error: ${error}`);
  process.exit(1);
});
