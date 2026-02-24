#!/usr/bin/env npx ts-node
"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const axios_1 = __importDefault(require("axios"));
const ollama_1 = require("ollama");
const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
function log(message) {
    console.log(`[${new Date().toISOString()}] [DocIngester] ${message}`);
}
function logError(message) {
    console.error(`[${new Date().toISOString()}] [DocIngester] ${message}`);
}
function herokuHeaders() {
    return { 'Content-Type': 'application/json', 'X-Worker-API-Key': WORKER_API_KEY };
}
// ---------------------------------------------------------------------------
// Ollama embedding
// ---------------------------------------------------------------------------
let ollama = null;
function getOllama() {
    if (!ollama)
        ollama = new ollama_1.Ollama({ host: OLLAMA_HOST });
    return ollama;
}
async function generateEmbedding(text) {
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
function extractDocId(url) {
    // /d/{docId}/ pattern
    const dMatch = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (dMatch)
        return dMatch[1];
    // ?id={docId} pattern
    const idMatch = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idMatch)
        return idMatch[1];
    return null;
}
/**
 * Fetch Google Doc content as plain text.
 * The doc must be shared as "Anyone with the link can view".
 */
async function fetchGoogleDocText(docId) {
    const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
    const response = await axios_1.default.get(exportUrl, {
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
function chunkText(text, chunkSize = 1500, overlap = 200) {
    const chunks = [];
    const paragraphs = text.split(/\n\n+/);
    let current = '';
    for (const para of paragraphs) {
        if (current.length + para.length + 2 > chunkSize && current.length > 0) {
            chunks.push(current.trim());
            // Keep overlap from the end of the current chunk
            const words = current.split(/\s+/);
            const overlapWords = words.slice(-Math.ceil(overlap / 5));
            current = overlapWords.join(' ') + '\n\n' + para;
        }
        else {
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
async function ingestDoc(url, title, docType) {
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
    let content;
    try {
        content = await fetchGoogleDocText(docId);
    }
    catch (error) {
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
    const chunks = [];
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
    const response = await axios_1.default.post(`${HEROKU_API_URL}/api/team-documents`, { source_url: url, title, doc_type: docType, chunks }, { headers: herokuHeaders(), timeout: 60000 });
    log(`  ✅ Stored ${response.data.chunks_stored} chunks for "${title}"`);
}
async function listDocs() {
    const response = await axios_1.default.get(`${HEROKU_API_URL}/api/team-documents`, { headers: herokuHeaders(), timeout: 15000 });
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
async function deleteDoc(url) {
    const response = await axios_1.default.delete(`${HEROKU_API_URL}/api/team-documents`, { data: { source_url: url }, headers: herokuHeaders(), timeout: 15000 });
    log(`Deleted ${response.data.chunks_deleted} chunks for "${url}"`);
}
// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function run() {
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
    // Ingest: <url> --title "name" [--type design]
    const url = args.find(a => a.startsWith('https://'));
    if (!url) {
        logError('Usage:');
        logError('  npm run ingest-doc -- <google-drive-url> --title "Doc Name" [--type design|requirements|runbook]');
        logError('  npm run ingest-doc -- --list');
        logError('  npm run ingest-doc -- --delete <url>');
        process.exit(1);
    }
    const titleIdx = args.indexOf('--title');
    const title = titleIdx >= 0 ? args[titleIdx + 1] : 'Untitled Document';
    const typeIdx = args.indexOf('--type');
    const docType = typeIdx >= 0 ? args[typeIdx + 1] : 'design';
    // Verify Ollama
    try {
        const client = getOllama();
        await client.embed({ model: OLLAMA_EMBED_MODEL, input: 'test' });
        log(`Ollama embedding model ready: ${OLLAMA_EMBED_MODEL}`);
    }
    catch (error) {
        logError(`Ollama not ready: ${error.message}`);
        logError(`Run: ollama pull ${OLLAMA_EMBED_MODEL}`);
        process.exit(1);
    }
    await ingestDoc(url, title, docType);
}
run().then(() => process.exit(0)).catch((error) => {
    logError(`Fatal error: ${error}`);
    process.exit(1);
});
//# sourceMappingURL=docIngester.js.map