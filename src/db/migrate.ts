import * as fs from 'fs';
import * as path from 'path';
import { pool } from './client';
import 'dotenv/config';

async function runMigrations(): Promise<void> {
  console.log('Running database migrations...');
  
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  
  for (const file of files) {
    console.log(`Running migration: ${file}`);
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    await pool.query(sql);
    console.log(`Completed: ${file}`);
  }
  
  console.log('All migrations completed successfully!');
  await pool.end();
}

runMigrations().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
