import { App } from '@slack/bolt';
/**
 * Process pending reminders and send messages for PRs without reviews.
 * Uses only worker-reported status from the database. Heroku cannot reach
 * internal GitHub Enterprise; the local worker must be running to report status.
 */
export declare function processPendingReminders(app: App): Promise<void>;
//# sourceMappingURL=reminder.d.ts.map