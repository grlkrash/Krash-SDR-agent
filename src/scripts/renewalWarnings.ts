// tsx src/scripts/renewalWarnings.ts
//
// Cron entry: scan closed-won deals 60d out from ss_renewal_date and draft
// a confident pre-renewal email for each. The worker handles per-deal
// try/catch and AuditLog of skips; this wrapper just brackets it with cron
// success/failure so the run is visible in /queue diagnostics.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { generateRenewalWarnings } from '../outreach/renewalWarning.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

try {
  await generateRenewalWarnings();
  await prisma.auditLog.create({ data: {
    action: 'cron.success',
    entity: 'renewalWarnings',
    meta: {},
  } });
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({ data: {
    action: 'cron.failure',
    entity: 'renewalWarnings',
    meta: { error: message },
  } });
  throw err;
}
