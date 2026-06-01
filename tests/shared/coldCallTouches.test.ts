import { describe, expect, it } from 'vitest';
import { businessDay } from '../../src/shared/businessDays.js';
import {
  COLD_CALL_MAX_TOUCHES,
  COLD_CALL_TOUCH_BD_OFFSETS,
  coldCallWindowEnd,
  coldTouchDueAt,
  isWithinColdCallWindow,
  nextPendingColdTouch,
} from '../../src/shared/coldCallTouches.js';

describe('coldCallTouches', () => {
  const sentAt = new Date('2026-05-04T15:00:00.000Z'); // Monday UTC

  it('schedules three touches on business days 2, 5, 9', () => {
    expect(COLD_CALL_TOUCH_BD_OFFSETS).toEqual([2, 5, 9]);
    expect(COLD_CALL_MAX_TOUCHES).toBe(3);
    expect(coldTouchDueAt(sentAt, 1).getDay()).not.toBe(0);
    expect(coldTouchDueAt(sentAt, 1).getDay()).not.toBe(6);
  });

  it('closes the window after 9 business days', () => {
    const end = coldCallWindowEnd(sentAt);
    expect(isWithinColdCallWindow(sentAt, businessDay(sentAt, 9))).toBe(true);
    expect(isWithinColdCallWindow(sentAt, businessDay(end, 1))).toBe(false);
  });

  it('returns the first incomplete touch when due', () => {
    const dueDay = coldTouchDueAt(sentAt, 1);
    const next = nextPendingColdTouch(sentAt, new Set<number>(), dueDay);
    expect(next?.touchNumber).toBe(1);
  });

  it('skips completed touches', () => {
    const onTouch3 = coldTouchDueAt(sentAt, 3);
    const next = nextPendingColdTouch(sentAt, new Set([1, 2]), onTouch3);
    expect(next?.touchNumber).toBe(3);
  });
});
