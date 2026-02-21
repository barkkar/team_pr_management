import * as fs from 'fs';
import * as path from 'path';
import { pool } from './client';
import 'dotenv/config';

async function runMigrations(): Promise<void> {
  console.log('Running database migrations...');

  // Create tracking table so we never re-run an already-applied migration
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    );
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  // Seed already-applied migrations on first run (if tables already exist)
  const existing = await pool.query('SELECT COUNT(*) as count FROM schema_migrations');
  if (parseInt(existing.rows[0].count, 10) === 0) {
    // Check if tracked_prs exists — if so, migrations 001-006 were already applied
    const tableCheck = await pool.query(`
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
        await pool.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
          [m],
        );
      }
      console.log(`Seeded ${previousMigrations.length} previously applied migrations`);
    }
  }

  // Get already-applied migrations
  const applied = await pool.query('SELECT filename FROM schema_migrations');
  const appliedSet = new Set(applied.rows.map((r: any) => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`Skipping (already applied): ${file}`);
      continue;
    }

    console.log(`Running migration: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
    console.log(`Completed: ${file}`);
  }

  console.log('All migrations completed successfully!');
  await pool.end();
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
