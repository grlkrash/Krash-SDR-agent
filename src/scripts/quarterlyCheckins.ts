// tsx src/scripts/quarterlyCheckins.ts
//
// Cron entry: scan closed-won deals at ~90/180/270d post-close and draft a
// warm CSM check-in for each. The worker handles per-deal try/catch and
// AuditLog of skips; this wrapper just brackets it with cron success/
// failure so the run is visible in /queue diagnostics.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { generateQuarterlyCheckins } from '../outreach/quarterlyCheckin.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

try {
  await generateQuarterlyCheckins();
  await prisma.auditLog.create({ data: {
    action: 'cron.success',
    entity: 'quarterlyCheckins',
    meta: {},
  } });
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({ data: {
    action: 'cron.failure',
    entity: 'quarterlyCheckins',
    meta: { error: message },
  } });
  throw err;
}
