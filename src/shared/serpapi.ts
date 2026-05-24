import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' });
const prisma = new PrismaClient({ adapter });

const SERPER_URL = 'https://google.serper.dev/search';

const OrganicResultSchema = z
  .object({
    link: z.string().optional(),
    title: z.string().optional(),
    snippet: z.string().optional(),
  })
  .passthrough();

const ResponseSchema = z
  .object({
    organic: z.array(OrganicResultSchema).optional(),
  })
  .passthrough();

export type SerpResult = { link?: string; title?: string; snippet?: string };

const logError = async (query: string, error: string): Promise<void> => {
  await prisma.auditLog.create({
    data: {
      action: 'serpapi.error',
      entity: 'query',
      entityId: query.slice(0, 200),
      meta: { error } as Prisma.InputJsonValue,
    },
  });
};

// Migrated from SerpAPI to Serper for cost. Export name kept for call-site stability.
export const serpapi = async (query: string, num = 5): Promise<SerpResult[]> => {
  const apiKey = process.env.SERPER_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    await logError(query, 'SERPER_API_KEY is not set');
    return [];
  }

  try {
    const res = await fetch(SERPER_URL, {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num }),
    });
    if (!res.ok) {
      await logError(query, `HTTP ${res.status} ${res.statusText}`);
      return [];
    }
    const json: unknown = await res.json();
    const parsed = ResponseSchema.parse(json);
    return parsed.organic ?? [];
  } catch (err) {
    await logError(query, err instanceof Error ? err.message : String(err));
    return [];
  }
};

const LINKEDIN_PROFILE_PREFIXES = ['https://www.linkedin.com/in/', 'https://linkedin.com/in/'];

const firstLinkedInProfile = (results: SerpResult[]): string | null => {
  const link = results[0]?.link;
  if (link === undefined) return null;
  return LINKEDIN_PROFILE_PREFIXES.some((p) => link.startsWith(p)) ? link : null;
};

export const findLinkedIn = async (
  ownerName: string,
  facilityName: string,
  city: string,
): Promise<string | null> => {
  const primary = await serpapi(`site:linkedin.com/in/ "${ownerName}" "${facilityName}"`, 5);
  const hit = firstLinkedInProfile(primary);
  if (hit !== null) return hit;
  const fallback = await serpapi(
    `site:linkedin.com/in/ "${ownerName}" ${city} addiction treatment`,
    5,
  );
  return firstLinkedInProfile(fallback);
};

const NAME_MAX_WORDS = 5;
const TITLE_AT_RE = /\s+at\s+.+$/i;
const LINKEDIN_SUFFIX_RE = /\s*\|\s*LinkedIn\s*$/i;
const SEPARATOR_RE = /\s+[-–—]\s+/;

const parseLinkedInResultTitle = (
  raw: string,
): { name: string; title: string | null } | null => {
  const cleaned = raw.replace(LINKEDIN_SUFFIX_RE, '').trim();
  if (cleaned === '') return null;
  const parts = cleaned.split(SEPARATOR_RE);
  const name = parts[0]?.trim() ?? '';
  if (name === '' || name.split(/\s+/).length > NAME_MAX_WORDS) return null;
  const rawTitle = parts[1]?.trim() ?? null;
  const title = rawTitle === null ? null : rawTitle.replace(TITLE_AT_RE, '').trim();
  return { name, title: title === '' ? null : title };
};

export const findFacilityLeadership = async (
  facilityName: string,
): Promise<{ name: string; title: string | null; linkedIn: string } | null> => {
  const results = await serpapi(
    `site:linkedin.com "${facilityName}" "Executive Director" OR "Clinical Director"`,
    5,
  );
  for (const r of results) {
    const link = r.link;
    const title = r.title;
    if (link === undefined || title === undefined) continue;
    if (!LINKEDIN_PROFILE_PREFIXES.some((p) => link.startsWith(p))) continue;
    const parsed = parseLinkedInResultTitle(title);
    if (parsed === null) continue;
    return { name: parsed.name, title: parsed.title, linkedIn: link };
  }
  return null;
};
