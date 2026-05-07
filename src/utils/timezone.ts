import { DateTime } from 'luxon';

const CUTOFF_HOUR = 17; // 5:00 PM
const BUSINESS_START_HOUR = 9; // 9:00 AM

/**
 * Calculate when a PR becomes eligible for a reminder.
 *
 * Rules (evaluated in the channel's configured timezone):
 * - If posted before 5:00 PM: eligible after `intervalHours` (if still within 9 AM - 5 PM)
 * - If posted at 5:00 PM or later: eligible at 9:00 AM next business day
 * - If the delay pushes past 5 PM: eligible at 9:00 AM next business day
 */
export function getEligibleReminderTime(
  postedAt: Date,
  intervalHours: number,
  timezone: string,
): Date {
  const postedLocal = DateTime.fromJSDate(postedAt).setZone(timezone);

  if (postedLocal.hour >= CUTOFF_HOUR) {
    let nextDay = postedLocal.plus({ days: 1 }).set({
      hour: BUSINESS_START_HOUR,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
    while (nextDay.weekday === 6 || nextDay.weekday === 7) {
      nextDay = nextDay.plus({ days: 1 });
    }
    return nextDay.toJSDate();
  } else {
    const eligibleTime = postedLocal.plus({ hours: intervalHours });

    if (eligibleTime.hour >= CUTOFF_HOUR) {
      let nextDay = postedLocal.plus({ days: 1 }).set({
        hour: BUSINESS_START_HOUR,
        minute: 0,
        second: 0,
        millisecond: 0,
      });
      while (nextDay.weekday === 6 || nextDay.weekday === 7) {
        nextDay = nextDay.plus({ days: 1 });
      }
      return nextDay.toJSDate();
    }
    return eligibleTime.toJSDate();
  }
}

/**
 * Check if "now" falls within business hours (9 AM - 5 PM, Mon-Fri) in the
 * given timezone.
 */
export function isWithinBusinessHours(timezone: string): boolean {
  const now = DateTime.now().setZone(timezone);

  if (now.weekday === 6 || now.weekday === 7) {
    return false;
  }

  return now.hour >= BUSINESS_START_HOUR && now.hour < CUTOFF_HOUR;
}

/**
 * Get the next eligible time for a recurring reminder (within 9 AM - 5 PM in
 * the given timezone).
 * - If now is outside 9-5 or weekend: return 9 AM next business day
 * - If now + interval is still within 9-5: return now + interval
 * - If now + interval would be past 5 PM: return 9 AM next business day
 */
export function getNextReminderEligibleTime(
  intervalHours: number,
  timezone: string,
): Date {
  const now = DateTime.now().setZone(timezone);

  if (now.weekday === 6 || now.weekday === 7 || now.hour < BUSINESS_START_HOUR || now.hour >= CUTOFF_HOUR) {
    let next = now.set({ hour: BUSINESS_START_HOUR, minute: 0, second: 0, millisecond: 0 });
    if (next <= now) {
      next = next.plus({ days: 1 });
    }
    while (next.weekday === 6 || next.weekday === 7) {
      next = next.plus({ days: 1 });
    }
    return next.toJSDate();
  }

  const inInterval = now.plus({ hours: intervalHours });
  if (inInterval.hour < CUTOFF_HOUR) {
    return inInterval.toJSDate();
  }

  let nextDay = now.plus({ days: 1 }).set({
    hour: BUSINESS_START_HOUR,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  while (nextDay.weekday === 6 || nextDay.weekday === 7) {
    nextDay = nextDay.plus({ days: 1 });
  }
  return nextDay.toJSDate();
}

/**
 * Validate an IANA timezone string via Luxon. Empty strings are rejected.
 */
export function isValidTimezone(tz: string): boolean {
  if (!tz || typeof tz !== 'string' || tz.trim() === '') {
    return false;
  }
  return DateTime.now().setZone(tz).isValid;
}

/**
 * Format a duration for display in messages (e.g., "2 hours", "19 minutes")
 */
export function formatTimeAgo(date: Date): string {
  const now = DateTime.now();
  const then = DateTime.fromJSDate(date);
  const diff = now.diff(then, ['days', 'hours', 'minutes']);

  if (diff.days >= 1) {
    const days = Math.floor(diff.days);
    return `${days} day${days !== 1 ? 's' : ''}`;
  } else if (diff.hours >= 1) {
    const hours = Math.floor(diff.hours);
    return `${hours} hour${hours !== 1 ? 's' : ''}`;
  } else {
    const minutes = Math.floor(diff.minutes);
    return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
  }
}
