import { App } from '@slack/bolt';
/**
 * Process pending reminders and send messages for PRs without reviews.
 * Uses only worker-reported status from the database. Heroku cannot reach
 * internal GitHub Enterprise; the local worker must be running to report status.
 * Reminders are only sent between 9 AM - 5 PM PST (Mon-Fri).
 */
export declare function processPendingReminders(app: App): Promise<void>;
//# sourceMappingURL=reminder.d.ts.map