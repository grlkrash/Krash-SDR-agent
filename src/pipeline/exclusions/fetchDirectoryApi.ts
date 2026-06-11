// Sobriety Select public directory search API (Meilisearch-backed).
// Verified / partner listings: subscriptionType "subscribe" | "ads" (~80–90 total).
// The ~9k "unsubscribe" rows are searchable catalog inventory, not SS clients.

import { z } from 'zod';
import { normalizeUsState } from './parseScrapedLabel.js';

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
