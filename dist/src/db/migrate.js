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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const client_1 = require("./client");
require("dotenv/config");
async function runMigrations() {
    console.log('Running database migrations...');
    // Create tracking table so we never re-run an already-applied migration
    await client_1.pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    );
  `);
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    // Seed already-applied migrations on first run (if tables already exist)
    const existing = await client_1.pool.query('SELECT COUNT(*) as count FROM schema_migrations');
    if (parseInt(existing.rows[0].count, 10) === 0) {
        // Check if tracked_prs exists — if so, migrations 001-006 were already applied
        const tableCheck = await client_1.pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables WHERE table_name = 'tracked_prs'
      ) as exists
    `);
        if (tableCheck.rows[0].exists) {
            console.log('Seeding schema_migrations with previously applied migrations...');
            const previousMigrations = [
                '001_create_tracked_prs.sql',
                '002_create_channel_poll_state.sql',
                '003_add_pr_status_fields.sql',
                '004_create_monitored_channels.sql',
                '005_add_reminder_count.sql',
                '006_drop_pr_closed_use_is_open.sql',
            ];
            for (const m of previousMigrations) {
                await client_1.pool.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [m]);
            }
            console.log(`Seeded ${previousMigrations.length} previously applied migrations`);
        }
    }
    // Get already-applied migrations
    const applied = await client_1.pool.query('SELECT filename FROM schema_migrations');
    const appliedSet = new Set(applied.rows.map((r) => r.filename));
    for (const file of files) {
        if (appliedSet.has(file)) {
            console.log(`Skipping (already applied): ${file}`);
            continue;
        }
        console.log(`Running migration: ${file}`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
        await client_1.pool.query(sql);
        await client_1.pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        console.log(`Completed: ${file}`);
    }
    console.log('All migrations completed successfully!');
    await client_1.pool.end();
}
runMigrations().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
//# sourceMappingURL=migrate.js.map