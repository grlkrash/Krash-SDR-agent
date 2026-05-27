import { addressHash, normalizeName } from '../../shared/lead.js';
import { extractDomain } from '../../shared/domain.js';
import type { MatchConfidence } from '../../shared/exclusion.js';
import type { ExclusionImportRow } from './normalizeRow.js';

export type LeadCandidate = {
  id: string;
  nameNormalized: string;
  addressHash: string;
  city: string;
  state: string;
  website: string | null;
};

export type LeadIndex = {
  byDomain: Map<string, LeadCandidate[]>;
  byAddressKey: Map<string, LeadCandidate>;
  byNameCityState: Map<string, LeadCandidate[]>;
};

const nameCityStateKey = (
  nameNormalized: string,
  city: string,
  state: string,
): string => `${nameNormalized}|${city.toLowerCase().trim()}|${state.toLowerCase().trim()}`;

export const buildLeadIndex = (leads: LeadCandidate[]): LeadIndex => {
  const byDomain = new Map<string, LeadCandidate[]>();
  const byAddressKey = new Map<string, LeadCandidate>();
  const byNameCityState = new Map<string, LeadCandidate[]>();

  for (const lead of leads) {
    const domain = extractDomain(lead.website);
    if (domain !== null) {
      const bucket = byDomain.get(domain) ?? [];
      bucket.push(lead);
      byDomain.set(domain, bucket);
    }

    const addrKey = `${lead.nameNormalized}|${lead.addressHash}`;
    if (!byAddressKey.has(addrKey)) byAddressKey.set(addrKey, lead);

    const ncs = nameCityStateKey(lead.nameNormalized, lead.city, lead.state);
    const ncsBucket = byNameCityState.get(ncs) ?? [];
    ncsBucket.push(lead);
    byNameCityState.set(ncs, ncsBucket);
  }

  return { byDomain, byAddressKey, byNameCityState };
};

const pickSingle = (candidates: LeadCandidate[]): LeadCandidate | 'ambiguous' | 'none' => {
  if (candidates.length === 0) return 'none';
  if (candidates.length === 1) return candidates[0];
  return 'ambiguous';
};

export type MatchResult =
  | { status: 'matched'; leadId: string; confidence: MatchConfidence }
  | { status: 'ambiguous'; leadIds: string[]; confidence: MatchConfidence }
  | { status: 'unmatched' };

export const matchImportRowToLead = (
  row: ExclusionImportRow,
  index: LeadIndex,
): MatchResult => {
  const rowNameNorm = normalizeName(row.name);
  const rowAddrKey = `${rowNameNorm}|${addressHash(row.street, row.zip)}`;

  if (row.street !== null && row.zip !== null) {
    const hit = index.byAddressKey.get(rowAddrKey);
    if (hit !== undefined) {
      return { status: 'matched', leadId: hit.id, confidence: 'address' };
    }
  }

  if (row.domain !== null) {
    const domainHits = index.byDomain.get(row.domain) ?? [];
    const narrowed =
      row.street !== null && row.zip !== null
        ? domainHits.filter((l) => l.addressHash === addressHash(row.street, row.zip))
        : domainHits;
    const picked = pickSingle(narrowed.length > 0 ? narrowed : domainHits);
    if (picked === 'ambiguous') {
      return {
        status: 'ambiguous',
        leadIds: (narrowed.length > 0 ? narrowed : domainHits).map((l) => l.id),
        confidence: 'domain',
      };
    }
    if (picked !== 'none') {
      return { status: 'matched', leadId: picked.id, confidence: 'domain' };
    }
  }

  if (row.city !== null && row.state !== null) {
    const ncs = nameCityStateKey(rowNameNorm, row.city, row.state);
    const hits = index.byNameCityState.get(ncs) ?? [];
    const picked = pickSingle(hits);
    if (picked === 'ambiguous') {
      return { status: 'ambiguous', leadIds: hits.map((l) => l.id), confidence: 'name-city-state' };
    }
    if (picked !== 'none') {
      return { status: 'matched', leadId: picked.id, confidence: 'name-city-state' };
    }
  }

  return { status: 'unmatched' };
};
