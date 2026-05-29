import { describe, expect, it } from 'vitest';
import {
  bucketForKind,
  formatRate,
  ratePct,
} from '../../src/outreach/emailEngagementStats.js';

describe('bucketForKind', () => {
  it('maps sequence and post-sale kinds to stable buckets', () => {
    expect(bucketForKind('cold')).toBe('cold');
    expect(bucketForKind('followup-2')).toBe('followup-2');
    expect(bucketForKind('followup-5')).toBe('followup-5');
    expect(bucketForKind('reactivation')).toBe('reactivation');
    expect(bucketForKind('nudge')).toBe('nudge');
  });

  it('falls back to other for unknown kinds', () => {
    expect(bucketForKind('voicemail')).toBe('other');
    expect(bucketForKind('custom-kind')).toBe('other');
  });
});

describe('ratePct', () => {
  it('returns null when denominator is zero', () => {
    expect(ratePct(0, 0)).toBeNull();
    expect(ratePct(3, 0)).toBeNull();
  });

  it('rounds to one decimal place', () => {
    expect(ratePct(1, 3)).toBe(33.3);
    expect(ratePct(2, 5)).toBe(40);
    expect(ratePct(5, 5)).toBe(100);
  });
});

describe('formatRate', () => {
  it('formats percentages and missing values', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(42.5)).toBe('42.5%');
  });
});
