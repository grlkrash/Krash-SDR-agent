// tsx src/scripts/scorePipeline.ts
//
// Cron entry: score every open HubSpot deal and persist one Score row per
// deal. The pipeline function does all the real work — this wrapper just
// brackets it with cron success/failure AuditLog rows so the run is visible
// in /queue diagnostics.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { scoreAllDeals } from '../pipeline/scoring.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

try {
  await scoreAllDeals();
  await prisma.auditLog.create({ data: {
    action: 'cron.success',
    entity: 'scorePipeline',
    meta: {},
  } });
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({ data: {
    action: 'cron.failure',
    entity: 'scorePipeline',
    meta: { error: message },
  } });
  throw err;
}
