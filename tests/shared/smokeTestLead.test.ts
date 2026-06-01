import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  isSmokeTestLead,
  isSmokeTestLeadRecord,
} from '../../src/shared/smokeTestLead.js';

describe('isSmokeTestLeadRecord', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('matches SMOKE_TEST_LEAD_ID from env', () => {
    vi.stubEnv('SMOKE_TEST_LEAD_ID', 'lead-abc');
    expect(isSmokeTestLead('lead-abc')).toBe(true);
    expect(isSmokeTestLeadRecord({ id: 'lead-abc', name: 'Real Facility LLC' })).toBe(true);
  });

  it('matches the SMOKE name prefix from seeded lanes', () => {
    expect(isSmokeTestLeadRecord({
      id: 'x',
      name: 'SMOKE Cold Test Recovery LLC',
    })).toBe(true);
    expect(isSmokeTestLeadRecord({
      id: 'x',
      name: 'Smoke Cold Test Recovery LLC',
    })).toBe(false);
  });

  it('matches sourceMeta.smokeLane', () => {
    expect(isSmokeTestLeadRecord({
      id: 'x',
      name: 'Some Facility',
      sourceMeta: { smokeLane: 'cold' },
    })).toBe(true);
  });

  it('does not match normal production leads', () => {
    expect(isSmokeTestLeadRecord({
      id: 'prod-1',
      name: 'Sunrise Recovery Center',
      sourceMeta: { source: 'hubspot' },
    })).toBe(false);
  });
});
