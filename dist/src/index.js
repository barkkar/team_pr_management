"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const app_1 = require("./app");
async function main() {
    // Validate required environment variables
    const required = ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN', 'GHE_TOKEN'];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
        console.error(`Missing required environment variables: ${missing.join(', ')}`);
        process.exit(1);
    }
    const app = (0, app_1.createApp)();
    const port = parseInt(process.env.PORT || '3000', 10);
    await app.start(port);
    console.log(`⚡️ PR Review Reminder bot is running on port ${port}!`);
}
main().catch((error) => {
    console.error('Failed to start app:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map