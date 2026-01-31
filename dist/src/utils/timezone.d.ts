/**
 * Calculate when a PR becomes eligible for a reminder
 *
 * Rules:
 * - If posted before 4:00 PM PST: eligible after 2 hours
 * - If posted at 4:00 PM PST or later: eligible at 10:00 AM next business day
 */
export declare function getEligibleReminderTime(postedAt: Date): Date;
/**
 * Check if current time is within business hours (10 AM - 4 PM PST, Mon-Fri)
 */
export declare function isWithinBusinessHours(): boolean;
/**
 * Format a date for display in messages
 */
export declare function formatTimeAgo(date: Date): string;
//# sourceMappingURL=timezone.d.ts.map