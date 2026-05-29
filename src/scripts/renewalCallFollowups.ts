// tsx src/scripts/renewalCallFollowups.ts
//
// Daily cron: create HubSpot tasks for due renewal call touches (BD 3–7)
// and expire sequences past the 7-business-day window.

import 'dotenv/config';
import { runRenewalCallFollowups } from '../outreach/renewalCallFlag.js';

try {
  await runRenewalCallFollowups();
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
  });
  await prisma.auditLog.create({
    data: {
      action: 'cron.failure',
      entity: 'renewalCallFollowups',
      meta: { error: err instanceof Error ? err.message : String(err) },
    },
  });
  throw err;
}
