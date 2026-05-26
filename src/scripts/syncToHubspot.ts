// tsx src/scripts/syncToHubspot.ts
//
// Cron entry (5:45 AM ET): sync every enriched lead not yet mirrored to HubSpot.
// Concurrency 5; the per-call 100ms pacing and hsRetry live inside
// syncLeadToHubspot, so this script just orchestrates.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { syncLeadToHubspot } from '../pipeline/hubspotSync.js';

const CONCURRENCY = 5;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const runConcurrent = async <T>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<void>,
): Promise<void> => {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (cursor < items.length) await fn(items[cursor++]);
  }));
};

try {
  const leads = await prisma.lead.findMany({
    where: {
      hubspotCompanyId: null,
      enrichment: { isNot: null },
    },
    select: { id: true },
  });

  let ok = 0;
  let fail = 0;
  await runConcurrent(leads, CONCURRENCY, async (lead) => {
    try {
      await syncLeadToHubspot(lead.id);
      ok += 1;
    } catch (err) {
      fail += 1;
      await prisma.auditLog.create({ data: {
        action: 'hubspotSync.failure',
        entity: 'lead',
        entityId: lead.id,
        meta: { error: err instanceof Error ? err.message : String(err) },
      } });
    }
  });

  await prisma.auditLog.create({ data: {
    action: 'cron.success',
    entity: 'syncToHubspot',
    meta: { total: leads.length, ok, fail },
  } });
  console.log(JSON.stringify({ total: leads.length, ok, fail }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({ data: {
    action: 'cron.failure',
    entity: 'syncToHubspot',
    meta: { error: message },
  } });
  throw err;
}
