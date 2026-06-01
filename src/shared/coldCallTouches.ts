// Cold-call touch schedule: a 3-touch phone cadence interleaved into the cold
// email sequence. Touch 1 lands 2 business days after the cold email sends
// (email first, then the call), touch 2 at BD 5, touch 3 at BD 9. The window
// closes after BD 9 — past that the prospect rolls into normal email follow-up.

import { businessDay } from './businessDays.js';

/** Business-day offsets from the cold-email send date for touches 1–3. */
export const COLD_CALL_TOUCH_BD_OFFSETS = [2, 5, 9] as const;
export const COLD_CALL_MAX_TOUCHES = 3;
export const COLD_CALL_WINDOW_BD = 9;

export type ColdCallTouchNumber = 1 | 2 | 3;

export const coldTouchBusinessDayOffset = (touchNumber: ColdCallTouchNumber): number =>
  COLD_CALL_TOUCH_BD_OFFSETS[touchNumber - 1] ?? COLD_CALL_WINDOW_BD;

export const coldTouchDueAt = (sentAt: Date, touchNumber: ColdCallTouchNumber): Date =>
  businessDay(sentAt, coldTouchBusinessDayOffset(touchNumber));

export const coldCallWindowEnd = (sentAt: Date): Date =>
  businessDay(sentAt, COLD_CALL_WINDOW_BD);

const startOfUtcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export const isWithinColdCallWindow = (sentAt: Date, now: Date): boolean =>
  startOfUtcDay(now).getTime() <= startOfUtcDay(coldCallWindowEnd(sentAt)).getTime();

export const nextPendingColdTouch = (
  sentAt: Date,
  completedTouchNumbers: Set<number>,
  now: Date,
): { touchNumber: ColdCallTouchNumber; dueAt: Date } | null => {
  for (let i = 1; i <= COLD_CALL_MAX_TOUCHES; i += 1) {
    const touchNumber = i as ColdCallTouchNumber;
    if (completedTouchNumbers.has(touchNumber)) continue;
    const dueAt = coldTouchDueAt(sentAt, touchNumber);
    if (startOfUtcDay(now).getTime() >= startOfUtcDay(dueAt).getTime()) {
      return { touchNumber, dueAt };
    }
  }
  for (let i = 1; i <= COLD_CALL_MAX_TOUCHES; i += 1) {
    const touchNumber = i as ColdCallTouchNumber;
    if (completedTouchNumbers.has(touchNumber)) continue;
    return { touchNumber, dueAt: coldTouchDueAt(sentAt, touchNumber) };
  }
  return null;
};
