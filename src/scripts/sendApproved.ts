// tsx src/scripts/sendApproved.ts
//
// Cron entry: send every approved-but-not-yet-sent draft. Routing happens
// in sendApprovedDraft (sender.ts): email kinds (cold/followup-N/replied
// /quarterly/renewal/upsell/reactivation/nudge) ship via Gmail; voicemail
// kinds (voicemail, voicemail-2) ship via Twilio. The 200ms pacing keeps
// us under Gmail's per-second send quota and gives HubSpot's
// engagement-create rate limit headroom too; voicemail Twilio calls
// inherit the same pace, which is plenty for the lookups/calls APIs.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { sendApprovedDraft } from '../outreach/sender.js';

const PACING_MS = 200;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const main = async (): Promise<void> => {
  if (!process.env.GMAIL_REFRESH_TOKEN) {
    await prisma.auditLog.create({ data: {
      action: 'cron.skipped',
      entity: 'sendApproved',
      entityId: null,
      meta: { reason: 'GMAIL_REFRESH_TOKEN not set — manual-send phase' },
    } });
    console.log(JSON.stringify({ status: 'skipped', reason: 'no Gmail credentials yet' }));
    return;
  }

  try {
    const drafts = await prisma.draft.findMany({
      where: {
        status: 'approved',
        sentAt: null,
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
};

await main();
