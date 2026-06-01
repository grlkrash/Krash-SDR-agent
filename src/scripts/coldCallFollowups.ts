// tsx src/scripts/coldCallFollowups.ts
//
// Daily cron: advance the 3-touch cold-call cadence — create HubSpot tasks for
// due touches (BD 2/5/9), retire sequences when the lead replies or books, and
// expire sequences past the BD-9 window.

import 'dotenv/config';
import { runColdCallFollowups } from '../outreach/coldCallFlag.js';

try {
  await runColdCallFollowups();
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
      entity: 'coldCallFollowups',
      meta: { error: err instanceof Error ? err.message : String(err) },
    },
  });
  throw err;
}
