// tsx src/scripts/syncCallDispositions.ts
//
// Daily cron: pull recent outbound HubSpot call engagements into AuditLog so the
// engagement dashboard reflects calls dispositioned directly in HubSpot (not
// just via /cold-call). Runs before sendDailyBrief. Idempotent.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { syncRecentCallDispositions } from '../outreach/callDispositionSync.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

try {
  const result = await syncRecentCallDispositions();
  await prisma.auditLog.create({
    data: { action: 'cron.success', entity: 'syncCallDispositions', meta: result },
  });
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({
    data: { action: 'cron.failure', entity: 'syncCallDispositions', meta: { error: message } },
  });
  throw err;
}
