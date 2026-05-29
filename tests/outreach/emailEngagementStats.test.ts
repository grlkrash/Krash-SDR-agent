import { describe, expect, it } from 'vitest';
import {
  bucketForKind,
  draftSentWithinRange,
  engagementRangeLabel,
  formatRate,
  parseEngagementRange,
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

describe('parseEngagementRange', () => {
  it('accepts known period values and defaults to all', () => {
    expect(parseEngagementRange('7d')).toBe('7d');
    expect(parseEngagementRange('90d')).toBe('90d');
    expect(parseEngagementRange('all')).toBe('all');
    expect(parseEngagementRange(undefined)).toBe('all');
    expect(parseEngagementRange('365d')).toBe('all');
  });
});

describe('draftSentWithinRange', () => {
  const nowMs = Date.parse('2026-05-29T12:00:00Z');

  it('includes all sends for all-time range', () => {
    const sentAt = new Date('2024-01-01T00:00:00Z');
    expect(draftSentWithinRange(sentAt, 'all', nowMs)).toBe(true);
  });

  it('filters by rolling window from sentAt', () => {
    const inside = new Date(nowMs - 5 * 86_400_000);
    const outside = new Date(nowMs - 10 * 86_400_000);
    expect(draftSentWithinRange(inside, '7d', nowMs)).toBe(true);
    expect(draftSentWithinRange(outside, '7d', nowMs)).toBe(false);
  });
});

describe('engagementRangeLabel', () => {
  it('returns human labels for each range', () => {
    expect(engagementRangeLabel('30d')).toBe('Last 30 days');
    expect(engagementRangeLabel('all')).toBe('All time');
  });
});
