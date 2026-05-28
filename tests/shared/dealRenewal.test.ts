import { describe, it, expect } from 'vitest';
import {
  computeRenewalDate,
  contractTermPartnershipLabel,
  formatHsDateOnly,
  hsDateOnlyEqual,
  parseContractTermMonths,
} from '../../src/shared/dealRenewal.js';

describe('parseContractTermMonths', () => {
  it('accepts 3, 6, and 12', () => {
    expect(parseContractTermMonths('3')).toBe(3);
    expect(parseContractTermMonths('6')).toBe(6);
    expect(parseContractTermMonths('12')).toBe(12);
  });

  it('rejects invalid values', () => {
    expect(parseContractTermMonths('')).toBeNull();
    expect(parseContractTermMonths('9')).toBeNull();
    expect(parseContractTermMonths(null)).toBeNull();
  });
});

describe('computeRenewalDate', () => {
  it('adds months in UTC calendar space', () => {
    const close = new Date(Date.UTC(2026, 0, 15));
    const renewal = computeRenewalDate(close, 6);
    expect(formatHsDateOnly(renewal)).toBe('2026-07-15');
  });

  it('handles year rollover', () => {
    const close = new Date(Date.UTC(2026, 10, 1));
    const renewal = computeRenewalDate(close, 3);
    expect(formatHsDateOnly(renewal)).toBe('2027-02-01');
  });
});

describe('hsDateOnlyEqual', () => {
  it('compares UTC date parts only', () => {
    const a = new Date(Date.UTC(2026, 5, 1, 0, 0, 0));
    const b = new Date(Date.UTC(2026, 5, 1, 23, 59, 59));
    expect(hsDateOnlyEqual(a, b)).toBe(true);
  });
});

describe('contractTermPartnershipLabel', () => {
  it('maps terms to readable labels', () => {
    expect(contractTermPartnershipLabel(3)).toBe('three-month');
    expect(contractTermPartnershipLabel(6)).toBe('six-month');
    expect(contractTermPartnershipLabel(12)).toBe('twelve-month');
  });
});
