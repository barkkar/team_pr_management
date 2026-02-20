import { DateTime } from 'luxon';

const TIMEZONE = 'America/Los_Angeles'; // PST/PDT
const CUTOFF_HOUR = 17; // 5:00 PM
const BUSINESS_START_HOUR = 9; // 9:00 AM
const REMINDER_DELAY_HOURS = 2;

/**
 * Calculate when a PR becomes eligible for a reminder
 *
 * Rules:
 * - If posted before 5:00 PM PST: eligible after 2 hours (if within 9 AM - 5 PM)
 * - If posted at 5:00 PM PST or later: eligible at 9:00 AM next business day
 * - If 2-hour delay pushes past 5 PM: eligible at 9:00 AM next business day
 */
export function getEligibleReminderTime(postedAt: Date): Date {
  const postedPST = DateTime.fromJSDate(postedAt).setZone(TIMEZONE);
  
  if (postedPST.hour >= CUTOFF_HOUR) {
    // Posted after 5 PM - wait until 9 AM next business day
    let nextDay = postedPST.plus({ days: 1 }).set({
      hour: BUSINESS_START_HOUR,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
    
    // Skip weekends
    while (nextDay.weekday === 6 || nextDay.weekday === 7) {
      nextDay = nextDay.plus({ days: 1 });
    }
    return nextDay.toJSDate();
  } else {
    // Posted before 4 PM - eligible after 2 hours
    const eligibleTime = postedPST.plus({ hours: REMINDER_DELAY_HOURS });
    
    // If the 2-hour delay pushes past 5 PM, wait until next day 9 AM
    if (eligibleTime.hour >= CUTOFF_HOUR) {
      let nextDay = postedPST.plus({ days: 1 }).set({
        hour: BUSINESS_START_HOUR,
        minute: 0,
        second: 0,
        millisecond: 0,
      });
      
      // Skip weekends
      while (nextDay.weekday === 6 || nextDay.weekday === 7) {
        nextDay = nextDay.plus({ days: 1 });
      }
      
      return nextDay.toJSDate();
    }
    return eligibleTime.toJSDate();
  }
}

/**
 * Check if current time is within business hours (9 AM - 5 PM PST, Mon-Fri)
 */
export function isWithinBusinessHours(): boolean {
  const now = DateTime.now().setZone(TIMEZONE);

  // Check if it's a weekday
  if (now.weekday === 6 || now.weekday === 7) {
    return false;
  }

  // Check if within business hours (9 AM - 5 PM)
  return now.hour >= BUSINESS_START_HOUR && now.hour < CUTOFF_HOUR;
}

/**
 * Get the next eligible time for a recurring reminder (within 9 AM - 5 PM PST).
 * - If now is outside 9-5 or weekend: return 9 AM next business day
 * - If now + 2 hours is still within 9-5: return now + 2 hours
 * - If now + 2 hours would be past 5 PM: return 9 AM next business day
 */
export function getNextReminderEligibleTime(): Date {
  const now = DateTime.now().setZone(TIMEZONE);

  if (now.weekday === 6 || now.weekday === 7 || now.hour < BUSINESS_START_HOUR || now.hour >= CUTOFF_HOUR) {
    // Outside business hours - next slot is 9 AM next business day
    let next = now.set({ hour: BUSINESS_START_HOUR, minute: 0, second: 0, millisecond: 0 });
    if (next <= now) {
      next = next.plus({ days: 1 });
    }
    while (next.weekday === 6 || next.weekday === 7) {
      next = next.plus({ days: 1 });
    }
    return next.toJSDate();
  }

  const inTwoHours = now.plus({ hours: REMINDER_DELAY_HOURS });
  if (inTwoHours.hour < CUTOFF_HOUR) {
    return inTwoHours.toJSDate();
  }

  // Now + 2 hours would be past 5 PM - schedule for 9 AM next business day
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
