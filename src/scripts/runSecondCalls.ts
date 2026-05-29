// tsx src/scripts/runSecondCalls.ts
//
// Cron entry: draft vm-2 for consent-gated vm-1 drops (post-sale only).
// Requires Lead.priorWrittenConsent — same policy as dropVoicemails.

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
        priorWrittenConsent: true,
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
      meta: { total: candidates.length, ok, fail, mode: 'consent-gated-post-sale' },
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
