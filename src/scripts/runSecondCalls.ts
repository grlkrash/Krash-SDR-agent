// tsx src/scripts/runSecondCalls.ts
//
// Cron entry: draft a second-touch voicemail (kind='voicemail-2') for every
// lead whose first voicemail was successfully dropped at least 3 business
// days ago, and that hasn't already had a voicemail-2 drafted.
//
// The 3-business-day gap is Stevi's pattern: the prospect has had time to
// hear the first voicemail and Sonia's voice is no longer unfamiliar; a
// second call now has a meaningfully higher chance of catching the
// decision maker live (which triggers the bridge in twilioHooks.ts).
//
// runSecondCalls drafts only. The actual call (TwiML bridge or VM drop)
// happens via sendApproved once Sonia approves the draft from /queue.
// Approval is the implicit consent: she's signaling availability for the
// bridge to her phone within the next 10 minutes (sendApproved's interval).

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { dropVoicemail2 } from '../outreach/voicemail2.js';
import { businessDay } from '../shared/businessDays.js';

const BUSINESS_DAYS_GAP = 3;
const DAILY_CAP = 50;
const PACING_MS = 1_000;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const main = async (): Promise<void> => {
  try {
    const cutoff = businessDay(new Date(), -BUSINESS_DAYS_GAP);

    const candidates = await prisma.lead.findMany({
      where: {
        phoneE164: { not: null },
        doNotContact: false,
        drafts: {
          some: {
            kind: 'voicemail',
            status: 'voicemail-dropped',
            sentAt: { lte: cutoff },
          },
          none: { kind: 'voicemail-2' },
        },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
      take: DAILY_CAP,
    });

    let ok = 0;
    let fail = 0;
    for (const lead of candidates) {
      try {
        await dropVoicemail2(lead.id);
        ok += 1;
      } catch (err) {
        fail += 1;
        await prisma.auditLog.create({ data: {
          action: 'voicemail2.failure',
          entity: 'Lead',
          entityId: lead.id,
          meta: { error: err instanceof Error ? err.message : String(err) },
        } });
      }
      await sleep(PACING_MS);
    }

    await prisma.auditLog.create({ data: {
      action: 'cron.success',
      entity: 'runSecondCalls',
      meta: { total: candidates.length, ok, fail },
    } });
    console.log(JSON.stringify({ total: candidates.length, ok, fail }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.auditLog.create({ data: {
      action: 'cron.failure',
      entity: 'runSecondCalls',
      meta: { error: message },
    } });
    throw err;
  }
};

await main();
