// tsx src/scripts/enrichAll.ts

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { enrichLead } from '../pipeline/enrich.js';

const CONCURRENCY = 5;
const BATCH_SLEEP_MS = 1000;
const MAX_LEADS_PER_RUN = 200;

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const runConcurrent = async <T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> => {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (cursor < items.length) await fn(items[cursor++]);
  }));
};

const leads = await prisma.lead.findMany({
  where: { enrichment: null }, select: { id: true }, take: MAX_LEADS_PER_RUN,
});

let ok = 0;
let fail = 0;
for (let i = 0; i < leads.length; i += CONCURRENCY) {
  const batch = leads.slice(i, i + CONCURRENCY);
  await runConcurrent(batch, CONCURRENCY, async (lead) => {
    try { await enrichLead(lead.id); ok += 1; } catch (err) {
      fail += 1;
      await prisma.auditLog.create({ data: {
        action: 'enrich.failure', entity: 'lead', entityId: lead.id,
        meta: { error: err instanceof Error ? err.message : String(err) },
      } });
    }
  });
  if (i + CONCURRENCY < leads.length) await sleep(BATCH_SLEEP_MS);
}

await prisma.auditLog.create({ data: { action: 'cron.success', entity: 'enrichAll', meta: { total: leads.length, ok, fail } } });
console.log(JSON.stringify({ total: leads.length, ok, fail }));
