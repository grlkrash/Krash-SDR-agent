import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { claude, extractJSON } from '../shared/claude.js';
import { fetchSite } from '../shared/fetchSite.js';
import { normalizeName, upsertLead } from '../shared/lead.js';
import { prisma } from '../shared/prismaClient.js';
import { serpapi, type SerpResult } from '../shared/serpapi.js';
import { rateLimit, sleep } from '../shared/asyncUtils.js';

const WAYBACK_AVAILABLE_URL = 'https://archive.org/wayback/available';
const CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';
const PROMPT_HTML_LIMIT = 20_000;
const DEFAULT_SEARCH_RESULTS = 8;
const DEFAULT_PAGE_CONCURRENCY = 2;
const DEFAULT_MAX_PAGES_PER_EVENT = 12;
const DEFAULT_MAX_SERPER_QUERIES = 25;
const DEFAULT_MAX_CLAUDE_EXTRACTS = 50;
const DEFAULT_SERPER_DELAY_MS = 200;
const DEFAULT_CLAUDE_DELAY_MS = 250;
const DEFAULT_WAYBACK_DELAY_MS = 1_000;
const DEFAULT_CITY = 'Unknown';
const DEFAULT_STATE = 'XX';

export type SponsorDiscoverySummary = {
  pagesFetched: number;
  brandsFound: number;
  newLeads: number;
  dupeCount: number;
};

type ProjectProfile = {
  comparableEvents: string[];
  city: string;
  state: string;
};

type SponsorEvidence = {
  quote: string;
  sourceUrl: string;
  event: string;
  year: string | null;
  tier: string | null;
};

const SponsorSchema = z
  .object({
    brandName: z.string().trim().min(1),
    year: z.union([z.string(), z.number()]).nullable().optional(),
    tier: z.string().nullable().optional(),
    evidenceQuote: z.string().nullable().optional(),
  })
  .transform((s) => ({
    brandName: s.brandName,
    year: s.year === null || s.year === undefined ? null : String(s.year).trim() || null,
    tier: s.tier?.trim() || null,
    evidenceQuote: s.evidenceQuote?.trim() || '',
  }));

const ExtractionSchema = z.object({
  sponsors: z.array(SponsorSchema),
});

type ExtractedSponsor = z.infer<typeof SponsorSchema>;

const WaybackSchema = z
  .object({
    archived_snapshots: z
      .object({
        closest: z
          .object({
            url: z.string().url().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const readPositiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
};

const parseList = (raw: string | undefined): string[] => {
  if (raw === undefined || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string').map((s) => s.trim()).filter(Boolean);
    }
  } catch {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
};

const envKeyForSlug = (projectSlug: string): string =>
  projectSlug.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

const humanizeSlug = (projectSlug: string): string =>
  projectSlug
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const profileFromJson = (projectSlug: string): ProjectProfile | null => {
  const raw = process.env.SPONSOR_DISCOVERY_PROFILES_JSON;
  if (raw === undefined || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;
    const profile = parsed[projectSlug];
    if (!isRecord(profile)) return null;
    const comparableEvents = Array.isArray(profile.comparableEvents)
      ? profile.comparableEvents
          .filter((item): item is string => typeof item === 'string')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (comparableEvents.length === 0) return null;
    return {
      comparableEvents,
      city: typeof profile.city === 'string' && profile.city.trim() !== '' ? profile.city.trim() : DEFAULT_CITY,
      state:
        typeof profile.state === 'string' && profile.state.trim() !== ''
          ? profile.state.trim().slice(0, 2).toUpperCase()
          : DEFAULT_STATE,
    };
  } catch {
    return null;
  }
};

const getDiscoveryProfile = (projectSlug: string): ProjectProfile => {
  const jsonProfile = profileFromJson(projectSlug);
  if (jsonProfile !== null) return jsonProfile;

  const slugKey = envKeyForSlug(projectSlug);
  const comparableEvents =
    parseList(process.env[`SPONSOR_DISCOVERY_EVENTS_${slugKey}`]).length > 0
      ? parseList(process.env[`SPONSOR_DISCOVERY_EVENTS_${slugKey}`])
      : parseList(process.env.SPONSOR_DISCOVERY_COMPARABLE_EVENTS);

  return {
    comparableEvents: comparableEvents.length > 0 ? comparableEvents : [humanizeSlug(projectSlug)],
    city: process.env[`SPONSOR_DISCOVERY_CITY_${slugKey}`] ?? process.env.SPONSOR_DISCOVERY_DEFAULT_CITY ?? DEFAULT_CITY,
    state:
      (process.env[`SPONSOR_DISCOVERY_STATE_${slugKey}`] ?? process.env.SPONSOR_DISCOVERY_DEFAULT_STATE ?? DEFAULT_STATE)
        .slice(0, 2)
        .toUpperCase(),
  };
};

const buildQueries = (eventName: string, year: number): string[] => [
  `${eventName} sponsors`,
  `${eventName} ${year} sponsors`,
  `${eventName} presented by`,
];

const stripHtml = (html: string): string =>
  html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const buildExtractionPrompt = (pageUrl: string, pageText: string): string => {
  const trimmed = pageText.slice(0, PROMPT_HTML_LIMIT);
  return `Extract every brand named as a sponsor, exhibitor, partner, or "presented by" brand on this page.
URL: ${pageUrl}

Return JSON exactly like:
{"sponsors":[{"brandName":"...", "year":"2022", "tier":"presenting", "evidenceQuote":"..."}]}

Rules:
- Output ONLY valid JSON. No preamble, no markdown fences.
- Include only named brands, companies, healthcare organizations, nonprofits, or trade partners.
- Exclude navigation labels, the event organizer itself, locations, dates, people, and generic headings.
- evidenceQuote must be a short exact quote from the page showing why the brand was included.
- If none found, return {"sponsors":[]}.

Page text:
${trimmed}`;
};

const normalizeResultUrl = (result: SerpResult): string | null => {
  const link = result.link?.trim();
  if (link === undefined || link === '') return null;
  try {
    const url = new URL(link);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
};

const waybackTimestamp = (year: number): string => `${year}1231`;

let waybackChain = Promise.resolve();

const withWaybackThrottle = async <T>(fn: () => Promise<T>): Promise<T> => {
  const delayMs = readPositiveInt('WAYBACK_DELAY_MS', DEFAULT_WAYBACK_DELAY_MS);
  const run = waybackChain.then(async () => {
    await sleep(delayMs);
    return fn();
  });
  waybackChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const tryWaybackSnapshot = async (url: string, year: number): Promise<string | null> =>
  withWaybackThrottle(async () => {
    const params = new URLSearchParams({
      url,
      timestamp: waybackTimestamp(year),
    });
    try {
      const res = await fetch(`${WAYBACK_AVAILABLE_URL}?${params.toString()}`);
      if (!res.ok) return null;
      const json: unknown = await res.json();
      const parsed = WaybackSchema.parse(json);
      return parsed.archived_snapshots?.closest?.url ?? null;
    } catch {
      return null;
    }
  });

const extractSponsors = async (
  pageUrl: string,
  html: string,
): Promise<ExtractedSponsor[]> => {
  const prompt = buildExtractionPrompt(pageUrl, stripHtml(html));
  const msg = await claude.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    temperature: 0,
    system: 'You extract event sponsor brands. Output ONLY valid JSON. No preamble, no markdown fences.',
    messages: [{ role: 'user', content: prompt }],
  });
  const parsed = ExtractionSchema.parse(extractJSON<unknown>(msg));
  return parsed.sponsors;
};

const sourceMetaWithEvidence = (
  projectSlug: string,
  eventName: string,
  evidence: SponsorEvidence,
): Prisma.InputJsonObject => {
  const sponsorshipHistory = evidence.year === null ? [eventName] : [`${eventName} ${evidence.year}`];
  return {
    projectSlug,
    sponsorDiscovery: true,
    provenSponsor: true,
    reviewState: 'needs_review',
    sponsorshipHistory,
    evidence: [evidence],
  };
};

const logAudit = async (
  action: string,
  projectSlug: string,
  meta: Prisma.InputJsonObject,
): Promise<void> => {
  await prisma.auditLog.create({
    data: {
      action,
      entity: 'project',
      entityId: projectSlug,
      meta,
    },
  });
};

export const runSponsorDiscovery = async (
  projectSlug: string,
): Promise<SponsorDiscoverySummary> => {
  const profile = getDiscoveryProfile(projectSlug);
  const discoveryYear = readPositiveInt(
    'SPONSOR_DISCOVERY_YEAR',
    new Date().getUTCFullYear(),
  );
  const searchResults = readPositiveInt(
    'SPONSOR_DISCOVERY_SERPER_RESULTS',
    DEFAULT_SEARCH_RESULTS,
  );
  const maxPagesPerEvent = readPositiveInt(
    'SPONSOR_DISCOVERY_MAX_PAGES_PER_EVENT',
    DEFAULT_MAX_PAGES_PER_EVENT,
  );
  const pageConcurrency = readPositiveInt(
    'SPONSOR_DISCOVERY_PAGE_CONCURRENCY',
    DEFAULT_PAGE_CONCURRENCY,
  );
  const maxSerperQueries = readPositiveInt(
    'SPONSOR_DISCOVERY_MAX_SERPER_QUERIES',
    DEFAULT_MAX_SERPER_QUERIES,
  );
  const maxClaudeExtracts = readPositiveInt(
    'SPONSOR_DISCOVERY_MAX_CLAUDE_EXTRACTS',
    DEFAULT_MAX_CLAUDE_EXTRACTS,
  );
  const serperDelayMs = readPositiveInt('SERPER_DELAY_MS', DEFAULT_SERPER_DELAY_MS);
  const claudeDelayMs = readPositiveInt('CLAUDE_DELAY_MS', DEFAULT_CLAUDE_DELAY_MS);
  let serperQueries = 0;
  let claudeExtracts = 0;
  let pagesFetched = 0;
  let brandsFound = 0;
  let newLeads = 0;
  let dupeCount = 0;

  await logAudit('sponsorDiscovery.request', projectSlug, {
    comparableEvents: profile.comparableEvents,
  });

  for (const eventName of profile.comparableEvents) {
    const seenUrls = new Set<string>();
    const queries = buildQueries(eventName, discoveryYear);
    for (const query of queries) {
      if (serperQueries >= maxSerperQueries) {
        await logAudit('sponsorDiscovery.providerBudgetExceeded', projectSlug, {
          provider: 'serper',
          maxSerperQueries,
        });
        break;
      }

      let results: SerpResult[] = [];
      try {
        results = await serpapi(query, searchResults);
        serperQueries += 1;
      } catch (err) {
        await logAudit('sponsorDiscovery.serpError', projectSlug, {
          query,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      await sleep(serperDelayMs);

      const remainingPages = maxPagesPerEvent - seenUrls.size;
      if (remainingPages <= 0) break;
      const urls = results
        .map(normalizeResultUrl)
        .filter((url): url is string => url !== null)
        .filter((url) => !seenUrls.has(url))
        .slice(0, remainingPages);

      await rateLimit(urls, pageConcurrency, async (url) => {
        if (seenUrls.has(url)) return;
        seenUrls.add(url);
        try {
          let page = await fetchSite(url);
          if (page === null) {
            const snapshotUrl = await tryWaybackSnapshot(url, discoveryYear);
            if (snapshotUrl !== null) {
              page = await fetchSite(snapshotUrl);
            }
          }
          if (page === null) return;

          pagesFetched += 1;
          if (claudeExtracts >= maxClaudeExtracts) {
            await logAudit('sponsorDiscovery.providerBudgetExceeded', projectSlug, {
              provider: 'claude',
              maxClaudeExtracts,
            });
            return;
          }
          claudeExtracts += 1;
          await sleep(claudeDelayMs);

          const sourceUrl = page.finalUrl ?? url;
          const sponsors = await extractSponsors(sourceUrl, page.html);
          for (const sponsor of sponsors) {
            const brandName = sponsor.brandName.trim();
            if (brandName === '') continue;
            brandsFound += 1;

            const evidence: SponsorEvidence = {
              quote: sponsor.evidenceQuote,
              sourceUrl,
              event: eventName,
              year: sponsor.year,
              tier: sponsor.tier,
            };
            const nameNormalized = normalizeName(brandName);
            const existing = await prisma.lead.findFirst({
              where: { nameNormalized },
              select: { id: true },
              orderBy: { createdAt: 'asc' },
            });
            const sourceMeta = sourceMetaWithEvidence(projectSlug, eventName, evidence);
            if (existing !== null) {
              await prisma.lead.update({
                where: { id: existing.id },
                data: { sourceMeta },
              });
              dupeCount += 1;
            } else {
              await upsertLead({
                source: 'sponsor-discovery',
                name: brandName,
                street: null,
                city: profile.city,
                state: profile.state,
                zip: null,
                phone: null,
                website: null,
                googleRating: null,
                googleReviews: null,
                services: [],
                sourceMeta,
              });
              newLeads += 1;
            }
          }
        } catch (err) {
          await logAudit('sponsorDiscovery.pageError', projectSlug, {
            url,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }
  }

  const summary = { pagesFetched, brandsFound, newLeads, dupeCount };
  await logAudit('sponsorDiscovery.complete', projectSlug, {
    pagesFetched,
    brandsFound,
    newLeads,
    dupeCount,
  });
  return summary;
};
