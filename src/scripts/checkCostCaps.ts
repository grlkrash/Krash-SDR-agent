// tsx src/scripts/checkCostCaps.ts
//
// Daily cron: aggregate MTD API spend from AuditLog cost.usage rows and email
// BRIEF_RECIPIENT when any auto-tracked provider crosses 80% or 100% of cap.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { checkCostCapsAndAlert } from '../outreach/costCapAlert.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

try {
  const result = await checkCostCapsAndAlert(prisma);
  await prisma.auditLog.create({
    data: {
      action: 'cron.success',
      entity: 'checkCostCaps',
      meta: { emailed: result.emailed, alerts: result.alerts },
    },
  });
  console.log(JSON.stringify({ ok: true, emailed: result.emailed, alerts: result.alerts }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({
    data: {
      action: 'cron.failure',
      entity: 'checkCostCaps',
      meta: { error: message },
    },
  });
  throw err;
}
