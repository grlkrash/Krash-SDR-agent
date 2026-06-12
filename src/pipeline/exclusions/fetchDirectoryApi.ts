// Sobriety Select public directory search API (Meilisearch-backed).
// Verified / partner listings: subscriptionType "subscribe" | "ads" (~80–90 total).
// The ~9k "unsubscribe" rows are searchable catalog inventory, not SS clients.

import { z } from 'zod';
import { extractDomain } from '../../shared/domain.js';
import { normalizeName } from '../../shared/lead.js';
import { normalizeUsState } from './parseScrapedLabel.js';

const MIN_NAME_OVERLAP_LEN = 10;

const BASE_URL = 'https://sobrietyselect.com/api/medical-centers/search';
const USER_AGENT = 'Sobriety Select Research/1.0 (sonia@sobrietyselect.com)';
const PAGE_LIMIT = 100;
const PACE_MS = 50;

export const DirectoryListing = z.object({
  slug: z.string(),
  name: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  address: z.string().nullable(),
  subscriptionType: z.enum(['subscribe', 'ads']),
  website: z.string().nullable(),
});
export type DirectoryListing = z.infer<typeof DirectoryListing>;

const HitSchema = z.object({
  slug: z.string(),
  title: z.string(),
  city: z.string().optional(),
  state: z.string().optional(),
  address: z.string().optional(),
  subscriptionType: z.string(),
  website: z.string().nullable().optional(),
});

const SearchResponse = z.object({
  hits: z.array(HitSchema),
  estimatedTotalHits: z.number(),
  limit: z.number(),
  offset: z.number(),
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const fetchSearchPage = async (
  filters: string,
  offset: number,
): Promise<z.infer<typeof SearchResponse>> => {
  const params = new URLSearchParams({
    q: '',
    limit: String(PAGE_LIMIT),
    offset: String(offset),
    filters,
  });
  const res = await fetch(`${BASE_URL}?${params.toString()}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`Directory search failed ${res.status}: ${filters}`);
  }
  return SearchResponse.parse(await res.json());
};

const fetchBySubscriptionType = async (
  subscriptionType: 'subscribe' | 'ads',
): Promise<DirectoryListing[]> => {
  const filters = `subscriptionType="${subscriptionType}"`;
  const out: DirectoryListing[] = [];
  let offset = 0;

  while (true) {
    const page = await fetchSearchPage(filters, offset);
    for (const hit of page.hits) {
      out.push(DirectoryListing.parse({
        slug: hit.slug,
        name: hit.title,
        city: hit.city ?? null,
        state: normalizeUsState(hit.state ?? '') ?? hit.state ?? null,
        address: hit.address ?? null,
        subscriptionType,
        website: hit.website ?? null,
      }));
    }
    offset += page.limit;
    if (offset >= page.estimatedTotalHits || page.hits.length === 0) break;
    await sleep(PACE_MS);
  }

  return out;
};

const CatalogHitSchema = z.object({
  slug: z.string(),
  title: z.string(),
  city: z.string().optional(),
  state: z.string().optional(),
  address: z.string().optional(),
  subscriptionType: z.string(),
  website: z.string().nullable().optional(),
});

export type DirectorySearchHit = {
  slug: string;
  name: string;
  city: string | null;
  state: string | null;
  address: string | null;
  subscriptionType: string;
  website: string | null;
};

const normalizeStateAbbrev = (raw: string | null | undefined): string => {
  if (raw === null || raw === undefined || raw.trim() === '') return '';
  const abbr = normalizeUsState(raw);
  return (abbr ?? raw).toUpperCase().slice(0, 2);
};

const citiesMatch = (facilityCity: string, hitCity: string | null): boolean => {
  if (hitCity === null || hitCity.trim() === '') return true;
  const fc = facilityCity.toLowerCase().trim();
  if (fc === '' || fc === 'unknown') return true;
  const hc = hitCity.toLowerCase().trim();
  const hitCityToken = hc.split(' ')[0] ?? hc;
  return fc === hc || hc.startsWith(fc) || fc.startsWith(hitCityToken);
};

const statesMatch = (facilityState: string, hitState: string | null): boolean => {
  if (facilityState === '' || facilityState === 'XX') return true;
  if (hitState === null || hitState.trim() === '') return true;
  return normalizeStateAbbrev(facilityState) === normalizeStateAbbrev(hitState);
};

const namesMatch = (facilityName: string, hitName: string): boolean => {
  const a = normalizeName(facilityName);
  const b = normalizeName(hitName);
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length < MIN_NAME_OVERLAP_LEN) return false;
  return longer.includes(shorter);
};

const slugMatchesDomain = (slug: string, domain: string): boolean => {
  const stem = domain.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (stem.length < 6) return false;
  const slugNorm = slug.toLowerCase().replace(/[^a-z0-9]/g, '');
  return slugNorm.includes(stem);
};

export type DirectoryFacilityRef = {
  name: string;
  website: string | null;
  city: string;
  state: string;
};

/** True when a Meilisearch hit is actually the facility being looked up — not a fuzzy neighbor. */
export const directoryHitMatchesFacility = (
  hit: DirectorySearchHit,
  facility: DirectoryFacilityRef,
): boolean => {
  const facilityDomain = extractDomain(facility.website);
  const hitDomain = extractDomain(hit.website);
  if (facilityDomain !== null && hitDomain !== null && facilityDomain === hitDomain) {
    return true;
  }

  if (facilityDomain !== null && slugMatchesDomain(hit.slug, facilityDomain)) {
    return citiesMatch(facility.city, hit.city) && statesMatch(facility.state, hit.state);
  }

  if (!namesMatch(facility.name, hit.name)) return false;
  return citiesMatch(facility.city, hit.city) && statesMatch(facility.state, hit.state);
};

export const filterDirectoryHitsForFacility = (
  hits: DirectorySearchHit[],
  facility: DirectoryFacilityRef,
): DirectorySearchHit[] => hits.filter((hit) => directoryHitMatchesFacility(hit, facility));

/**
 * Resolve this facility's SS directory listing. Domain search first (exact), then
 * name search with strict post-filter — raw Meilisearch hits are too fuzzy.
 */
export const lookupDirectoryForFacility = async (
  facility: DirectoryFacilityRef,
): Promise<DirectorySearchHit[]> => {
  const domain = extractDomain(facility.website);
  if (domain !== null) {
    const domainHits = await searchDirectoryByName(domain, 5);
    if (domainHits.length === 1) return domainHits;
    const domainFiltered = filterDirectoryHitsForFacility(domainHits, facility);
    if (domainFiltered.length > 0) return domainFiltered;
  }

  const nameHits = await searchDirectoryByName(facility.name, 12);
  return filterDirectoryHitsForFacility(nameHits, facility);
};

/** Search the SS directory catalog by facility name (all subscription tiers). */
export const searchDirectoryByName = async (
  query: string,
  limit = 8,
): Promise<DirectorySearchHit[]> => {
  const q = query.trim();
  if (q === '') return [];

  const params = new URLSearchParams({
    q,
    limit: String(limit),
    offset: '0',
  });
  const res = await fetch(`${BASE_URL}?${params.toString()}`, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`Directory name search failed ${res.status}`);
  }

  const parsed = z.object({ hits: z.array(CatalogHitSchema) }).parse(await res.json());
  return parsed.hits.map((hit) => ({
    slug: hit.slug,
    name: hit.title,
    city: hit.city ?? null,
    state: normalizeUsState(hit.state ?? '') ?? hit.state ?? null,
    address: hit.address ?? null,
    subscriptionType: hit.subscriptionType,
    website: hit.website ?? null,
  }));
};

/** All Sobriety Select verified / partner listings (subscribe + promoted ads). */
export const fetchVerifiedDirectoryListings = async (): Promise<DirectoryListing[]> => {
  const bySlug = new Map<string, DirectoryListing>();

  for (const subType of ['subscribe', 'ads'] as const) {
    const rows = await fetchBySubscriptionType(subType);
    for (const row of rows) {
      bySlug.set(row.slug, row);
    }
  }

  return Array.from(bySlug.values());
};

export type DirectoryCatalogStats = {
  verifiedListings: number;
  catalogTotalEstimate: number;
  byRegion: Array<{ region: string; catalogCount: number }>;
};

/** Informational counts — not used for cold exclusion. */
export const fetchDirectoryCatalogStats = async (): Promise<DirectoryCatalogStats> => {
  const res = await fetch('https://sobrietyselect.com/api/medical-centers/regions', {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!res.ok) throw new Error(`Regions API failed ${res.status}`);
  const parsed = z.object({
    regions: z.array(z.object({ name: z.string(), count: z.number() })),
  }).parse(await res.json());

  const catalogTotalEstimate = parsed.regions.reduce((sum, r) => sum + r.count, 0);
  return {
    verifiedListings: 0,
    catalogTotalEstimate,
    byRegion: parsed.regions.map((r) => ({ region: r.name, catalogCount: r.count })),
  };
};
