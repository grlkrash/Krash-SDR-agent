import { describe, expect, it } from 'vitest';
import { addressHash, normalizeName } from '../../src/shared/lead.js';
import { buildLeadIndex, matchRowToLead } from '../../src/pipeline/exclusions/matchLead.js';
import type { ExclusionImportRow } from '../../src/pipeline/exclusions/normalizeRow.js';

const row = (overrides: Partial<ExclusionImportRow>): ExclusionImportRow => ({
  externalId: null,
  name: 'Aspire Recovery Center',
  street: '100 Main St',
  city: 'Orlando',
  state: 'FL',
  zip: '32801',
  website: 'https://www.aspirerecovery.com',
  domain: 'aspirerecovery.com',
  email: null,
  phone: null,
  tier: 'select',
  status: 'active',
  ...overrides,
});

describe('matchRowToLead', () => {
  const lead = {
    id: 'lead-1',
    nameNormalized: normalizeName('Aspire Recovery Center'),
    addressHash: addressHash('100 Main St', '32801'),
    city: 'Orlando',
    state: 'FL',
    website: 'https://aspirerecovery.com',
  };
  const index = buildLeadIndex([lead]);

  it('matches on address key', () => {
    const match = matchRowToLead(row({}), index, [lead]);
    expect(match).toEqual({ status: 'matched', leadId: 'lead-1', confidence: 'address' });
  });

  it('matches base name + city when display name includes parenthetical city', () => {
    const match = matchRowToLead(
      row({ name: 'Aspire Recovery (Orlando)', city: 'Orlando', state: 'FL', street: null, zip: null }),
      buildLeadIndex([{
        ...lead,
        nameNormalized: normalizeName('Aspire Recovery'),
        city: 'Orlando',
        state: 'FL',
      }]),
      [{
        ...lead,
        nameNormalized: normalizeName('Aspire Recovery'),
        city: 'Orlando',
        state: 'FL',
      }],
    );
    expect(match.status).toBe('matched');
  });

  it('matches on domain when address differs', () => {
    const match = matchRowToLead(
      row({ street: '999 Other Rd', zip: '00000' }),
      index,
      [lead],
    );
    expect(match.status).toBe('matched');
    if (match.status === 'matched') {
      expect(match.leadId).toBe('lead-1');
      expect(match.confidence).toBe('domain');
    }
  });

  it('returns unmatched when nothing aligns', () => {
    const match = matchRowToLead(
      row({ name: 'Unknown Facility', domain: 'unknown.example', city: 'Denver', state: 'CO' }),
      index,
      [lead],
    );
    expect(match).toEqual({ status: 'unmatched' });
  });
});
