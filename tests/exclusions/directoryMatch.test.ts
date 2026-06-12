import { describe, expect, it } from 'vitest';
import {
  directoryHitMatchesFacility,
  filterDirectoryHitsForFacility,
  type DirectorySearchHit,
} from '../../src/pipeline/exclusions/fetchDirectoryApi.js';

const facility = {
  name: 'Options Recovery Services',
  website: 'https://optionsrecovery.org/',
  city: 'Berkeley',
  state: 'CA',
};

const unrelatedHits: DirectorySearchHit[] = [
  {
    slug: 'acceptance-recovery-counseling-coralville',
    name: 'Acceptance Recovery Counseling',
    city: 'Coralville',
    state: 'Iowa',
    address: null,
    subscriptionType: 'subscribe',
    website: null,
  },
  {
    slug: 'meta-addiction-treatment-haverhill',
    name: 'Meta Addiction Treatment (Haverhill)',
    city: 'Haverhill',
    state: 'Massachusetts',
    address: null,
    subscriptionType: 'ads',
    website: null,
  },
];

const optionsHit: DirectorySearchHit = {
  slug: 'options-recovery-services-berkeley',
  name: 'Options Recovery Services',
  city: 'Berkeley',
  state: 'California',
  address: null,
  subscriptionType: 'unsubscribe',
  website: null,
};

describe('directoryHitMatchesFacility', () => {
  it('rejects unrelated Meilisearch fuzzy neighbors', () => {
    for (const hit of unrelatedHits) {
      expect(directoryHitMatchesFacility(hit, facility)).toBe(false);
    }
  });

  it('accepts the actual facility by name and location', () => {
    expect(directoryHitMatchesFacility(optionsHit, facility)).toBe(true);
  });

  it('accepts slug match when website is on file but directory row has no URL', () => {
    expect(
      directoryHitMatchesFacility(optionsHit, {
        name: 'optionsrecovery.org',
        website: 'https://optionsrecovery.org',
        city: 'Berkeley',
        state: 'CA',
      }),
    ).toBe(true);
  });
});

describe('filterDirectoryHitsForFacility', () => {
  it('keeps only the target facility from a fuzzy result set', () => {
    const filtered = filterDirectoryHitsForFacility(
      [...unrelatedHits, optionsHit],
      facility,
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.name).toBe('Options Recovery Services');
  });
});
