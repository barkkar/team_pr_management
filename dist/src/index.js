"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const http = __importStar(require("http"));
const app_1 = require("./app");
const client_1 = require("./db/client");
// Simple body parser for JSON
async function parseJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            }
            catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}
// Validate worker API key
function validateApiKey(req) {
    const apiKey = req.headers['x-worker-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
    const expectedKey = process.env.WORKER_API_KEY;
    if (!expectedKey) {
        console.warn('WORKER_API_KEY not set - worker API disabled');
        return false;
    }
    return apiKey === expectedKey;
}
async function main() {
    // Validate required environment variables
    const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN', 'GHE_TOKEN'];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        process.exit(1);
    }
    const app = (0, app_1.createApp)();
    // Add Socket Mode connection event listeners BEFORE starting
    const socketModeClient = app.receiver?.client;
    if (socketModeClient) {
        socketModeClient.on('connected', () => {
            console.log('[Socket Mode] Connected to Slack');
        });
        socketModeClient.on('disconnected', () => {
            console.log('[Socket Mode] Disconnected from Slack');
        });
        socketModeClient.on('reconnecting', () => {
            console.log('[Socket Mode] Reconnecting...');
        });
        socketModeClient.on('error', (error) => {
            console.error('[Socket Mode] Error:', error.message);
        });
        socketModeClient.on('unable_to_socket_mode_start', (error) => {
            console.error('[Socket Mode] Unable to start:', error.message);
        });
        console.log('[Socket Mode] Event listeners registered');
    }
    else {
        console.warn('[Socket Mode] Could not access socket client for event listeners');
    }
    // Start the Slack app (Socket Mode - connects via WebSocket)
    await app.start();
    console.log('[Socket Mode] PR Review Reminder bot started');
    // Create HTTP server for health checks and worker API
    const port = parseInt(process.env.PORT || '3000', 10);
    const server = http.createServer(async (req, res) => {
        const url = req.url || '';
        const method = req.method || 'GET';
        // CORS headers for worker
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Worker-API-Key, Authorization');
        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }
        try {
            // Health check endpoints
            if (url === '/health' || url === '/') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'ok', app: 'pr-review-reminder' }));
                return;
            }
            // Worker API: Get PRs needing status check
            if (url === '/api/pending-prs' && method === 'GET') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const prs = await (0, client_1.getPRsNeedingStatusCheck)();
                console.log(`[Worker API] Returning ${prs.length} PRs for status check`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ prs }));
                return;
            }
            // Worker API: Update PR status
            if (url === '/api/pr-status' && method === 'POST') {
                if (!validateApiKey(req)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Unauthorized' }));
                    return;
                }
                const body = await parseJsonBody(req);
                const results = body.results || [];
                if (!Array.isArray(results)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid request body: expected { results: [...] }' }));
                    return;
                }
                let updated = 0;
                for (const result of results) {
                    if (result.pr_url && typeof result.is_open === 'boolean' && typeof result.has_reviews === 'boolean') {
                        await (0, client_1.updatePRStatus)(result.pr_url, result.is_open, result.has_reviews);
                        updated++;
                    }
                }
                console.log(`[Worker API] Updated status for ${updated} PRs`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ updated }));
                return;
            }
            // Not found
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
        }
        catch (error) {
            console.error('API error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message || 'Internal Server Error' }));
        }
    });
    server.listen(port, () => {
        console.log(`HTTP server listening on port ${port}`);
        console.log(`  - Health check: GET /health`);
        console.log(`  - Worker API: GET /api/pending-prs, POST /api/pr-status`);
    });
}
main().catch((error) => {
    console.error('Failed to start app:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map