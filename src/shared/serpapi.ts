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
