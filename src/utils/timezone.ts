import { DateTime } from 'luxon';

const TIMEZONE = 'America/Los_Angeles'; // PST/PDT
const CUTOFF_HOUR = 16; // 4:00 PM
const NEXT_DAY_START_HOUR = 10; // 10:00 AM
const REMINDER_DELAY_HOURS = 2;

/**
 * Calculate when a PR becomes eligible for a reminder
 * 
 * Rules:
 * - If posted before 4:00 PM PST: eligible after 2 hours
 * - If posted at 4:00 PM PST or later: eligible at 10:00 AM next business day
 */
export function getEligibleReminderTime(postedAt: Date): Date {
  const postedPST = DateTime.fromJSDate(postedAt).setZone(TIMEZONE);
  
  if (postedPST.hour >= CUTOFF_HOUR) {
    // Posted after 4 PM - wait until 10 AM next day
    let nextDay = postedPST.plus({ days: 1 }).set({
      hour: NEXT_DAY_START_HOUR,
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
    
    // If the 2-hour delay pushes past 4 PM, wait until next day 10 AM
    if (eligibleTime.hour >= CUTOFF_HOUR) {
      let nextDay = postedPST.plus({ days: 1 }).set({
        hour: NEXT_DAY_START_HOUR,
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
 * Check if current time is within business hours (10 AM - 4 PM PST, Mon-Fri)
 */
export function isWithinBusinessHours(): boolean {
  const now = DateTime.now().setZone(TIMEZONE);
  
  // Check if it's a weekday
  if (now.weekday === 6 || now.weekday === 7) {
    return false;
  }
  
  // Check if within business hours
  return now.hour >= NEXT_DAY_START_HOUR && now.hour < CUTOFF_HOUR;
}

/**
 * Format a date for display in messages
 */
export function formatTimeAgo(date: Date): string {
  const now = DateTime.now();
  const then = DateTime.fromJSDate(date);
  const diff = now.diff(then, ['hours', 'minutes']);
  
  if (diff.hours >= 1) {
    const hours = Math.floor(diff.hours);
    return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
  } else {
    const minutes = Math.floor(diff.minutes);
    return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
  }
}
