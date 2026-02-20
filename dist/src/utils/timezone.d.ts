/**
 * Calculate when a PR becomes eligible for a reminder
 *
 * Rules:
 * - If posted before 5:00 PM PST: eligible after 2 hours (if within 9 AM - 5 PM)
 * - If posted at 5:00 PM PST or later: eligible at 9:00 AM next business day
 * - If 2-hour delay pushes past 5 PM: eligible at 9:00 AM next business day
 */
export declare function getEligibleReminderTime(postedAt: Date): Date;
/**
 * Check if current time is within business hours (9 AM - 5 PM PST, Mon-Fri)
 */
export declare function isWithinBusinessHours(): boolean;
/**
 * Get the next eligible time for a recurring reminder (within 9 AM - 5 PM PST).
 * - If now is outside 9-5 or weekend: return 9 AM next business day
 * - If now + 2 hours is still within 9-5: return now + 2 hours
 * - If now + 2 hours would be past 5 PM: return 9 AM next business day
 */
export declare function getNextReminderEligibleTime(): Date;
/**
 * Format a duration for display in messages (e.g., "2 hours", "19 minutes")
 */
export declare function formatTimeAgo(date: Date): string;
//# sourceMappingURL=timezone.d.ts.map