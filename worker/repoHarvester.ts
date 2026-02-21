#!/usr/bin/env npx ts-node
/**
 * Repository Knowledge Harvester
 *
 * Fetches source code from git repos via GHE API and chunks it for RAG indexing.
 * Indexes key code files (not binaries, not huge files) into repo_knowledge table.
 *
 * Usage:
 *   npm run harvest:repos
 */

import 'dotenv/config';
import axios from 'axios';
import { requireTokenForHost } from '../src/utils/gheTokenResolver';

const HEROKU_API_URL = process.env.HEROKU_API_URL;
const WORKER_API_KEY = process.env.WORKER_API_KEY;

const MAX_FILE_SIZE = 50000; // Skip files larger than 50KB
const CHUNK_SIZE = 1500; // Characters per chunk
const CHUNK_OVERLAP = 200; // Overlap between chunks

// File extensions to index
const INDEXABLE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rs', 'rb', 'php',
  'c', 'cpp', 'h', 'hpp', 'cs', 'swift', 'kt', 'scala',
  'sql', 'graphql', 'proto',
  'json', 'yaml', 'yml', 'toml',
  'md', 'txt', 'rst',
  'sh', 'bash', 'zsh',
  'css', 'scss', 'less',
  'html', 'xml', 'svg',
  'dockerfile', 'makefile',
]);

// Directories to skip
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', '.git', '__pycache__',
  'vendor', '.next', '.nuxt', 'coverage', '.nyc_output',
  'target', 'bin', 'obj', '.idea', '.vscode',
]);

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] [RepoHarvester] ${message}`);
}

function logError(message: string): void {
  console.error(`[${new Date().toISOString()}] [RepoHarvester] ${message}`);
}

function herokuHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Worker-API-Key': WORKER_API_KEY!,
  };
}

// ---------------------------------------------------------------------------
// GHE API helpers
// ---------------------------------------------------------------------------

function extractHostname(prUrl: string): string | null {
  const match = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)/);
  return match ? match[1] : null;
}

async function fetchDefaultBranch(hostname: string, org: string, repo: string): Promise<string> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      timeout: 15000,
    },
  );
  return response.data.default_branch || 'main';
}

async function fetchLatestCommitSha(hostname: string, org: string, repo: string, branch: string): Promise<string> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/commits/${branch}`,
    {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      timeout: 15000,
    },
  );
  return response.data.sha;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

async function fetchRepoTree(hostname: string, org: string, repo: string, sha: string): Promise<TreeEntry[]> {
  const token = requireTokenForHost(hostname);
  const response = await axios.get(
    `https://${hostname}/api/v3/repos/${org}/${repo}/git/trees/${sha}`,
    {
      params: { recursive: 1 },
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      timeout: 60000,
    },
  );
  return response.data.tree || [];
}

async function fetchFileContent(hostname: string, org: string, repo: string, sha: string): Promise<string | null> {
  try {
    const token = requireTokenForHost(hostname);
    const response = await axios.get(
      `https://${hostname}/api/v3/repos/${org}/${repo}/git/blobs/${sha}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
        timeout: 15000,
      },
    );
    if (response.data.encoding === 'base64') {
      return Buffer.from(response.data.content, 'base64').toString('utf-8');
    }
    return response.data.content || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

function shouldIndexFile(path: string, size?: number): boolean {
  if (size && size > MAX_FILE_SIZE) return false;

  // Check if any parent directory is in skip list
  const parts = path.split('/');
  for (const part of parts.slice(0, -1)) {
    if (SKIP_DIRS.has(part.toLowerCase())) return false;
  }

  // Check extension
  const filename = parts[parts.length - 1].toLowerCase();
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) {
    // No extension — check for known filenames
    return ['dockerfile', 'makefile', 'rakefile', 'gemfile', 'procfile'].includes(filename);
  }
  const ext = filename.substring(dotIndex + 1);
  return INDEXABLE_EXTENSIONS.has(ext);
}

function chunkContent(filePath: string, content: string): { chunk: string; index: number }[] {
  const chunks: { chunk: string; index: number }[] = [];

  if (content.length <= CHUNK_SIZE) {
    chunks.push({ chunk: `File: ${filePath}\n\n${content}`, index: 0 });
    return chunks;
  }

  let offset = 0;
  let index = 0;

  while (offset < content.length) {
    const end = Math.min(offset + CHUNK_SIZE, content.length);
    const chunk = content.substring(offset, end);
    chunks.push({
      chunk: `File: ${filePath} (chunk ${index + 1})\n\n${chunk}`,
      index,
    });
    offset += CHUNK_SIZE - CHUNK_OVERLAP;
    index++;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Heroku API helpers
// ---------------------------------------------------------------------------

async function fetchDistinctRepos(): Promise<{ org: string; repo: string; hostname: string }[]> {
  const response = await axios.get(`${HEROKU_API_URL}/api/distinct-repos`, {
    headers: { 'X-Worker-API-Key': WORKER_API_KEY },
    timeout: 30000,
  });
  return response.data.repos || [];
}

async function fetchRepoHarvestState(org: string, repo: string): Promise<{ last_repo_harvest_sha: string | null } | null> {
  try {
    const response = await axios.get(`${HEROKU_API_URL}/api/harvest-state`, {
      params: { org, repo },
      headers: { 'X-Worker-API-Key': WORKER_API_KEY },
      timeout: 30000,
    });
    return response.data.state || null;
  } catch {
    return null;
  }
}

async function reportRepoKnowledge(data: {
  chunks: { org: string; repo: string; file_path: string; content_chunk: string; chunk_index: number; last_commit_sha: string }[];
  harvest_state: { org: string; repo: string; sha: string };
}): Promise<void> {
  await axios.post(`${HEROKU_API_URL}/api/repo-knowledge`, data, {
    headers: herokuHeaders(),
    timeout: 60000,
  });
}

// ---------------------------------------------------------------------------
// Main harvest logic
// ---------------------------------------------------------------------------

async function harvestRepo(hostname: string, org: string, repo: string): Promise<void> {
  log(`Harvesting codebase for ${org}/${repo} from ${hostname}...`);

  // Get default branch and latest commit
  const branch = await fetchDefaultBranch(hostname, org, repo);
  const latestSha = await fetchLatestCommitSha(hostname, org, repo, branch);
  log(`  Branch: ${branch}, SHA: ${latestSha.substring(0, 8)}`);

  // Check if already harvested at this SHA
  const state = await fetchRepoHarvestState(org, repo);
  if (state?.last_repo_harvest_sha === latestSha) {
    log(`  Already harvested at this SHA. Skipping.`);
    return;
  }

  // Fetch full tree
  const tree = await fetchRepoTree(hostname, org, repo, latestSha);
  const indexableFiles = tree.filter(
    entry => entry.type === 'blob' && shouldIndexFile(entry.path, entry.size),
  );
  log(`  Found ${indexableFiles.length} indexable files out of ${tree.length} total entries`);

  // Process files in batches
  const BATCH_SIZE = 20;
  let totalChunks = 0;

  for (let i = 0; i < indexableFiles.length; i += BATCH_SIZE) {
    const batch = indexableFiles.slice(i, i + BATCH_SIZE);
    const batchChunks: any[] = [];

    for (const file of batch) {
      const content = await fetchFileContent(hostname, org, repo, file.sha);
      if (!content) continue;

      const chunks = chunkContent(file.path, content);
      for (const { chunk, index } of chunks) {
        batchChunks.push({
          org,
          repo,
          file_path: file.path,
          content_chunk: chunk,
          chunk_index: index,
          last_commit_sha: latestSha,
        });
      }

      // Small rate limit between file fetches
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // Report batch
    if (batchChunks.length > 0) {
      try {
        await reportRepoKnowledge({
          chunks: batchChunks,
          harvest_state: { org, repo, sha: latestSha },
        });
        totalChunks += batchChunks.length;
        log(`  Reported batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batchChunks.length} chunks`);
      } catch (error: any) {
        logError(`  Failed to report batch: ${error.message}`);
      }
    }
  }

  log(`  Done: ${totalChunks} chunks harvested from ${org}/${repo}`);
}

async function run(): Promise<void> {
  log('='.repeat(60));
  log('Repository Knowledge Harvester starting...');
  log('='.repeat(60));

  if (!HEROKU_API_URL || !WORKER_API_KEY) {
    logError('HEROKU_API_URL and WORKER_API_KEY are required');
    process.exit(1);
  }

  if (!process.env.GHE_TOKEN && !process.env.GHE_TOKENS) {
    logError('GHE_TOKEN or GHE_TOKENS is required');
    process.exit(1);
  }

  let repos: { org: string; repo: string; hostname: string }[];
  try {
    repos = await fetchDistinctRepos();
    log(`Found ${repos.length} repo(s) to harvest`);
  } catch (error: any) {
    logError(`Failed to fetch repos: ${error.message}`);
    process.exit(1);
    return;
  }

  for (const { org, repo, hostname } of repos) {
    try {
      await harvestRepo(hostname, org, repo);
    } catch (error: any) {
      logError(`Failed to harvest ${org}/${repo}: ${error.message}`);
    }
  }

  log('Repository harvest complete!');
}

run().then(() => process.exit(0)).catch((error) => {
  logError(`Fatal error: ${error}`);
  process.exit(1);
});
