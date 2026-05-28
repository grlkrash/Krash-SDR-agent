// tsx src/scripts/syncDealRenewalDates.ts
//
// Cron entry: derive ss_renewal_date from closedate + ss_contract_term_months
// on every closed-won deal. Runs before renewalWarnings so the 60-day scan
// sees up-to-date dates without manual HubSpot edits.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { syncDealRenewalDates } from '../pipeline/syncDealRenewalDates.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

try {
  await syncDealRenewalDates();
  await prisma.auditLog.create({ data: {
    action: 'cron.success',
    entity: 'syncDealRenewalDates',
    meta: {},
  } });
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({ data: {
    action: 'cron.failure',
    entity: 'syncDealRenewalDates',
    meta: { error: message },
  } });
  throw err;
}
