// tsx src/scripts/sendApproved.ts
//
// Cron entry: send every approved-but-not-yet-sent cold/followup draft.
// 200ms pacing between sends keeps us well under Gmail's per-second send
// quota and gives HubSpot's engagement-create rate limit headroom too.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { sendApprovedDraft } from '../outreach/sender.js';

const PACING_MS = 200;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

try {
  const drafts = await prisma.draft.findMany({
    where: {
      status: 'approved',
      sentAt: null,
      kind: { not: 'voicemail' },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  let ok = 0;
  let fail = 0;
  for (const draft of drafts) {
    try {
      await sendApprovedDraft(draft.id);
      ok += 1;
    } catch (err) {
      fail += 1;
      await prisma.auditLog.create({ data: {
        action: 'sender.failure',
        entity: 'Draft',
        entityId: draft.id,
        meta: { error: err instanceof Error ? err.message : String(err) },
      } });
    }
    await sleep(PACING_MS);
  }

  await prisma.auditLog.create({ data: {
    action: 'cron.success',
    entity: 'sendApproved',
    meta: { total: drafts.length, ok, fail },
  } });
  console.log(JSON.stringify({ total: drafts.length, ok, fail }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({ data: {
    action: 'cron.failure',
    entity: 'sendApproved',
    meta: { error: message },
  } });
  throw err;
}
