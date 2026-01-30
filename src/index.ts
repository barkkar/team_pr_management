import 'dotenv/config';
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

  const port = parseInt(process.env.PORT || '3000', 10);

  await app.start(port);
  console.log(`⚡️ PR Review Reminder bot is running on port ${port}!`);
}

main().catch((error) => {
  console.error('Failed to start app:', error);
  process.exit(1);
});
