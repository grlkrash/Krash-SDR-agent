import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  CLAUDE_INPUT_USD_PER_TOKEN,
  CLAUDE_OUTPUT_USD_PER_TOKEN,
  PLACES_USD_PER_SEARCH,
  SERPER_USD_PER_CALL,
  VOYAGE_USD_PER_EMBED,
  type CostProvider,
} from './costCaps.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

type UsageMeta = {
  provider: CostProvider;
  estimatedUsd: number;
  units?: number;
  source?: string;
};

const persist = (meta: UsageMeta): void => {
  void prisma.auditLog
    .create({
      data: {
        action: 'cost.usage',
        entity: meta.provider,
        meta: meta as Prisma.InputJsonValue,
      },
    })
    .catch(() => {
      // Usage logging must never block or fail outbound API work.
    });
};

export const logSerperUsage = (source?: string): void => {
  persist({ provider: 'serper', estimatedUsd: SERPER_USD_PER_CALL, units: 1, source });
};

export const logPlacesUsage = (source?: string): void => {
  persist({ provider: 'places', estimatedUsd: PLACES_USD_PER_SEARCH, units: 1, source });
};

export const logVoyageUsage = (textCount: number, source?: string): void => {
  if (textCount <= 0) return;
  persist({
    provider: 'voyage',
    estimatedUsd: textCount * VOYAGE_USD_PER_EMBED,
    units: textCount,
    source,
  });
};

export const logClaudeUsage = (
  usage: { input_tokens: number; output_tokens: number },
  source?: string,
): void => {
  const estimatedUsd =
    usage.input_tokens * CLAUDE_INPUT_USD_PER_TOKEN +
    usage.output_tokens * CLAUDE_OUTPUT_USD_PER_TOKEN;
  if (estimatedUsd <= 0) return;
  persist({
    provider: 'claude',
    estimatedUsd,
    units: usage.input_tokens + usage.output_tokens,
    source,
  });
};
