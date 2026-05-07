/**
 * Calculate when a PR becomes eligible for a reminder.
 *
 * Rules (evaluated in the channel's configured timezone):
 * - If posted before 5:00 PM: eligible after `intervalHours` (if still within 9 AM - 5 PM)
 * - If posted at 5:00 PM or later: eligible at 9:00 AM next business day
 * - If the delay pushes past 5 PM: eligible at 9:00 AM next business day
 */
export declare function getEligibleReminderTime(postedAt: Date, intervalHours: number, timezone: string): Date;
/**
 * Check if "now" falls within business hours (9 AM - 5 PM, Mon-Fri) in the
 * given timezone.
 */
export declare function isWithinBusinessHours(timezone: string): boolean;
/**
 * Get the next eligible time for a recurring reminder (within 9 AM - 5 PM in
 * the given timezone).
 * - If now is outside 9-5 or weekend: return 9 AM next business day
 * - If now + interval is still within 9-5: return now + interval
 * - If now + interval would be past 5 PM: return 9 AM next business day
 */
export declare function getNextReminderEligibleTime(intervalHours: number, timezone: string): Date;
/**
 * Validate an IANA timezone string via Luxon. Empty strings are rejected.
 */
export declare function isValidTimezone(tz: string): boolean;
/**
 * Format a duration for display in messages (e.g., "2 hours", "19 minutes")
 */
export declare function formatTimeAgo(date: Date): string;
//# sourceMappingURL=timezone.d.ts.map