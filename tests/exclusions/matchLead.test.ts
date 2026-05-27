import { describe, expect, it } from 'vitest';
import { addressHash, normalizeName } from '../../src/shared/lead.js';
import { buildLeadIndex, matchImportRowToLead } from '../../src/pipeline/exclusions/matchLead.js';
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

describe('matchImportRowToLead', () => {
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
    const match = matchImportRowToLead(row({}), index);
    expect(match).toEqual({ status: 'matched', leadId: 'lead-1', confidence: 'address' });
  });

  it('matches on domain when address differs', () => {
    const match = matchImportRowToLead(
      row({ street: '999 Other Rd', zip: '00000' }),
      index,
    );
    expect(match.status).toBe('matched');
    if (match.status === 'matched') {
      expect(match.leadId).toBe('lead-1');
      expect(match.confidence).toBe('domain');
    }
  });

  it('returns unmatched when nothing aligns', () => {
    const match = matchImportRowToLead(
      row({ name: 'Unknown Facility', domain: 'unknown.example', city: 'Denver', state: 'CO' }),
      index,
    );
    expect(match).toEqual({ status: 'unmatched' });
  });
});
