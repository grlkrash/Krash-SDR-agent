import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' });
const prisma = new PrismaClient({ adapter });

const SERPAPI_URL = 'https://serpapi.com/search.json';

const OrganicResultSchema = z
  .object({
    link: z.string().optional(),
    title: z.string().optional(),
    snippet: z.string().optional(),
  })
  .passthrough();

const ResponseSchema = z
  .object({
    organic_results: z.array(OrganicResultSchema).optional(),
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

export const serpapi = async (query: string, num = 5): Promise<SerpResult[]> => {
  const apiKey = process.env.SERPAPI_KEY;
  if (apiKey === undefined || apiKey === '') {
    await logError(query, 'SERPAPI_KEY is not set');
    return [];
  }

  const url = `${SERPAPI_URL}?engine=google&q=${encodeURIComponent(query)}&num=${num}&api_key=${apiKey}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      await logError(query, `HTTP ${res.status} ${res.statusText}`);
      return [];
    }
    const json: unknown = await res.json();
    const parsed = ResponseSchema.parse(json);
    return parsed.organic_results ?? [];
  } catch (err) {
    await logError(query, err instanceof Error ? err.message : String(err));
    return [];
  }
};
