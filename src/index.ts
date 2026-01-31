import 'dotenv/config';
import * as http from 'http';
import { createApp } from './app';

async function main(): Promise<void> {
  // Validate required environment variables
  const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN', 'GHE_TOKEN'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  const app = createApp();

  // Start the Slack app (Socket Mode - connects via WebSocket)
  await app.start();
  console.log('⚡️ PR Review Reminder bot connected to Slack via Socket Mode!');

  // Create a simple HTTP server for Heroku health checks
  const port = parseInt(process.env.PORT || '3000', 10);
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', app: 'pr-review-reminder' }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(port, () => {
    console.log(`Health check server listening on port ${port}`);
  });
}

main().catch((error) => {
  console.error('Failed to start app:', error);
  process.exit(1);
});
