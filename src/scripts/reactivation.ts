// tsx src/scripts/reactivation.ts
//
// Cron entry (Mondays): scan open HubSpot deals stale >30d and draft a
// reactivation email for each lead with prior engagement (replied or
// follow-up) history. Global 10-drafts-per-week cap is enforced inside
// the worker. The worker also handles per-deal try/catch and AuditLog of
// skips; this wrapper just brackets it with cron success/failure so the
// run is visible in /queue diagnostics.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { generateReactivationDrafts } from '../outreach/reactivation.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

try {
  await generateReactivationDrafts();
  await prisma.auditLog.create({ data: {
    action: 'cron.success',
    entity: 'reactivation',
    meta: {},
  } });
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({ data: {
    action: 'cron.failure',
    entity: 'reactivation',
    meta: { error: message },
  } });
  throw err;
}
