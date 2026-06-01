// tsx src/scripts/attributeMeetings.ts
//
// Daily cron: attribute recently-booked HubSpot meetings to the email/sequence
// that sourced them. Runs before sendDailyBrief so the brief and the /queue
// engagement dashboard reflect fresh booking rates. Idempotent.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { attributeRecentMeetings } from '../outreach/meetingAttribution.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

try {
  const result = await attributeRecentMeetings();
  await prisma.auditLog.create({
    data: { action: 'cron.success', entity: 'attributeMeetings', meta: result },
  });
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({
    data: { action: 'cron.failure', entity: 'attributeMeetings', meta: { error: message } },
  });
  throw err;
}
