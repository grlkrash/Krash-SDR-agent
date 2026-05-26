// tsx src/scripts/sendDailyBrief.ts
//
// Cron entry: assemble and email today's pipeline brief. The brief function
// does all the real work — this wrapper just brackets it with cron success /
// failure AuditLog rows so the run is visible in /queue diagnostics.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { sendDailyBrief } from '../outreach/dailyBrief.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

try {
  await sendDailyBrief();
  await prisma.auditLog.create({ data: {
    action: 'cron.success',
    entity: 'sendDailyBrief',
    meta: {},
  } });
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({ data: {
    action: 'cron.failure',
    entity: 'sendDailyBrief',
    meta: { error: message },
  } });
  throw err;
}
