import { describe, expect, it } from 'vitest';
import { businessDay } from '../../src/shared/businessDays.js';
import {
  RENEWAL_MAX_TOUCHES,
  RENEWAL_TOUCH_BD_OFFSETS,
  isWithinRenewalCallWindow,
  nextPendingTouch,
  renewalCallWindowEnd,
  touchDueAt,
} from '../../src/shared/renewalCallTouches.js';

describe('renewalCallTouches', () => {
  const sentAt = new Date('2026-05-04T15:00:00.000Z'); // Monday UTC

  it('schedules five touches on business days 3–7', () => {
    expect(RENEWAL_TOUCH_BD_OFFSETS).toEqual([3, 4, 5, 6, 7]);
    expect(RENEWAL_MAX_TOUCHES).toBe(5);
    expect(touchDueAt(sentAt, 1).getDay()).not.toBe(0);
    expect(touchDueAt(sentAt, 1).getDay()).not.toBe(6);
  });

  it('closes window after 7 business days', () => {
    const end = renewalCallWindowEnd(sentAt);
    expect(isWithinRenewalCallWindow(sentAt, businessDay(sentAt, 7))).toBe(true);
    expect(isWithinRenewalCallWindow(sentAt, businessDay(end, 1))).toBe(false);
  });

  it('returns first incomplete touch when due', () => {
    const dueDay = touchDueAt(sentAt, 1);
    const next = nextPendingTouch(sentAt, new Set<number>(), dueDay);
    expect(next?.touchNumber).toBe(1);
  });

  it('skips completed touches', () => {
    const onDay5 = touchDueAt(sentAt, 3);
    const next = nextPendingTouch(sentAt, new Set([1, 2]), onDay5);
    expect(next?.touchNumber).toBe(3);
  });
});
