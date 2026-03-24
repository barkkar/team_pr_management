#!/usr/bin/env npx ts-node
"use strict";
/**
 * Repository Knowledge Harvester
 *
 * Fetches source code from git repos via GHE API and chunks it for RAG indexing.
 * Indexes key code files (not binaries, not huge files) into repo_knowledge table.
 *
 * Usage:
 *   npm run harvest:repos
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const errorNotifier_1 = require("../src/utils/errorNotifier");
const axios_1 = __importDefault(require("axios"));
const gheTokenResolver_1 = require("../src/utils/gheTokenResolver");
const minimatch_1 = require("minimatch");
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
function log(message) {
    console.log(`[${new Date().toISOString()}] [RepoHarvester] ${message}`);
}
function logError(message, severity = 'error') {
    console.error(`[${new Date().toISOString()}] [RepoHarvester] ${message}`);
    (0, errorNotifier_1.notifyError)('RepoHarvester', message, severity);
}
function herokuHeaders() {
    return {
        'Content-Type': 'application/json',
        'X-Worker-API-Key': WORKER_API_KEY,
    };
}
// ---------------------------------------------------------------------------
// GHE API helpers
// ---------------------------------------------------------------------------
function extractHostname(prUrl) {
    const match = prUrl.match(/https:\/\/([a-zA-Z0-9-]+\.soma\.salesforce\.com)/);
    return match ? match[1] : null;
}
async function fetchDefaultBranch(hostname, org, repo) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}`, {
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
        },
        timeout: 15000,
    });
    return response.data.default_branch || 'main';
}
async function fetchLatestCommitSha(hostname, org, repo, branch) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/commits/${branch}`, {
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
        },
        timeout: 15000,
    });
    return response.data.sha;
}
async function fetchRepoTree(hostname, org, repo, sha) {
    const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
    const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/git/trees/${sha}`, {
        params: { recursive: 1 },
        headers: {
            Authorization: `token ${token}`,
            Accept: 'application/vnd.github.v3+json',
        },
        timeout: 60000,
    });
    return response.data.tree || [];
}
async function fetchFileContent(hostname, org, repo, sha) {
    try {
        const token = (0, gheTokenResolver_1.requireTokenForHost)(hostname);
        const response = await axios_1.default.get(`https://${hostname}/api/v3/repos/${org}/${repo}/git/blobs/${sha}`, {
            headers: {
                Authorization: `token ${token}`,
                Accept: 'application/vnd.github.v3+json',
            },
            timeout: 15000,
        });
        if (response.data.encoding === 'base64') {
            return Buffer.from(response.data.content, 'base64').toString('utf-8');
        }
        return response.data.content || null;
    }
    catch {
        return null;
    }
}
let domainMappingsCache = null;
async function fetchDomainMappings() {
    if (domainMappingsCache) {
        return domainMappingsCache;
    }
    try {
        const response = await axios_1.default.get(`${HEROKU_API_URL}/api/domain-file-mappings`, {
            headers: { 'X-Worker-API-Key': WORKER_API_KEY },
            timeout: 30000,
        });
        const mappings = response.data.mappings || [];
        domainMappingsCache = mappings;
        return mappings;
    }
    catch (error) {
        logError(`Failed to fetch domain mappings: ${error.message}`, 'warn');
        return [];
    }
}
async function computeDomainForFile(filePath) {
    const mappings = await fetchDomainMappings();
    // Try each mapping in priority order (highest priority first)
    for (const mapping of mappings) {
        if ((0, minimatch_1.minimatch)(filePath, mapping.file_pattern)) {
            return mapping.domain_id;
        }
    }
    return null; // No domain match
}
function extractCodeElementInfo(content, filePath) {
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
// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------
function shouldIndexFile(path, size) {
    if (size && size > MAX_FILE_SIZE)
        return false;
    // Check if any parent directory is in skip list
    const parts = path.split('/');
    for (const part of parts.slice(0, -1)) {
        if (SKIP_DIRS.has(part.toLowerCase()))
            return false;
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
function chunkContent(filePath, content) {
    const chunks = [];
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
async function fetchDistinctRepos() {
    const response = await axios_1.default.get(`${HEROKU_API_URL}/api/distinct-repos`, {
        headers: { 'X-Worker-API-Key': WORKER_API_KEY },
        timeout: 30000,
    });
    return response.data.repos || [];
}
async function fetchRepoHarvestState(org, repo) {
    try {
        const response = await axios_1.default.get(`${HEROKU_API_URL}/api/harvest-state`, {
            params: { org, repo },
            headers: { 'X-Worker-API-Key': WORKER_API_KEY },
            timeout: 30000,
        });
        return response.data.state || null;
    }
    catch {
        return null;
    }
}
async function reportRepoKnowledge(data) {
    await axios_1.default.post(`${HEROKU_API_URL}/api/repo-knowledge`, data, {
        headers: herokuHeaders(),
        timeout: 60000,
    });
}
// ---------------------------------------------------------------------------
// Main harvest logic
// ---------------------------------------------------------------------------
async function harvestRepo(hostname, org, repo) {
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
    const indexableFiles = tree.filter(entry => entry.type === 'blob' && shouldIndexFile(entry.path, entry.size));
    log(`  Found ${indexableFiles.length} indexable files out of ${tree.length} total entries`);
    // Process files in batches
    const BATCH_SIZE = 20;
    let totalChunks = 0;
    for (let i = 0; i < indexableFiles.length; i += BATCH_SIZE) {
        const batch = indexableFiles.slice(i, i + BATCH_SIZE);
        const batchChunks = [];
        for (const file of batch) {
            const content = await fetchFileContent(hostname, org, repo, file.sha);
            if (!content)
                continue;
            // Compute domain and code element metadata
            const domainId = await computeDomainForFile(file.path);
            const { type: elementType, name: elementName } = extractCodeElementInfo(content, file.path);
            const chunks = chunkContent(file.path, content);
            for (const { chunk, index } of chunks) {
                batchChunks.push({
                    org,
                    repo,
                    file_path: file.path,
                    content_chunk: chunk,
                    chunk_index: index,
                    last_commit_sha: latestSha,
                    domain_id: domainId,
                    code_element_type: elementType,
                    code_element_name: elementName,
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
            }
            catch (error) {
                logError(`  Failed to report batch: ${error.message}`);
            }
        }
    }
    log(`  Done: ${totalChunks} chunks harvested from ${org}/${repo}`);
}
async function run() {
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
    let repos;
    try {
        repos = await fetchDistinctRepos();
        log(`Found ${repos.length} repo(s) to harvest`);
    }
    catch (error) {
        logError(`Failed to fetch repos: ${error.message}`);
        process.exit(1);
        return;
    }
    for (const { org, repo, hostname } of repos) {
        try {
            await harvestRepo(hostname, org, repo);
        }
        catch (error) {
            logError(`Failed to harvest ${org}/${repo}: ${error.message}`);
        }
    }
    log('Repository harvest complete!');
}
run().then(() => process.exit(0)).catch((error) => {
    logError(`Fatal error: ${error}`);
    process.exit(1);
});
//# sourceMappingURL=repoHarvester.js.map