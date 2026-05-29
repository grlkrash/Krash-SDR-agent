// Renewal call touch schedule: 5 touches on business days 3–7 after the
// renewal email sends. First task defaults to day 3; window closes after day 7.

import { businessDay } from './businessDays.js';

export const RENEWAL_FIRST_TOUCH_BD = 3;
export const RENEWAL_WINDOW_BD = 7;
export const RENEWAL_MAX_TOUCHES = 5;

/** Business-day offsets from send date for touches 1–5 (days 3–7). */
export const RENEWAL_TOUCH_BD_OFFSETS = [3, 4, 5, 6, 7] as const;

export type RenewalTouchNumber = 1 | 2 | 3 | 4 | 5;

export const touchBusinessDayOffset = (touchNumber: RenewalTouchNumber): number =>
  RENEWAL_TOUCH_BD_OFFSETS[touchNumber - 1] ?? RENEWAL_WINDOW_BD;

export const touchDueAt = (sentAt: Date, touchNumber: RenewalTouchNumber): Date =>
  businessDay(sentAt, touchBusinessDayOffset(touchNumber));

export const renewalCallWindowEnd = (sentAt: Date): Date =>
  businessDay(sentAt, RENEWAL_WINDOW_BD);

const startOfUtcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export const isWithinRenewalCallWindow = (sentAt: Date, now: Date): boolean =>
  startOfUtcDay(now).getTime() <= startOfUtcDay(renewalCallWindowEnd(sentAt)).getTime();

export const nextPendingTouch = (
  sentAt: Date,
  completedTouchNumbers: Set<number>,
  now: Date,
): { touchNumber: RenewalTouchNumber; dueAt: Date } | null => {
  for (let i = 1; i <= RENEWAL_MAX_TOUCHES; i += 1) {
    const touchNumber = i as RenewalTouchNumber;
    if (completedTouchNumbers.has(touchNumber)) continue;
    const dueAt = touchDueAt(sentAt, touchNumber);
    if (startOfUtcDay(now).getTime() >= startOfUtcDay(dueAt).getTime()) {
      return { touchNumber, dueAt };
    }
  }
  for (let i = 1; i <= RENEWAL_MAX_TOUCHES; i += 1) {
    const touchNumber = i as RenewalTouchNumber;
    if (completedTouchNumbers.has(touchNumber)) continue;
    return { touchNumber, dueAt: touchDueAt(sentAt, touchNumber) };
  }
  return null;
};
