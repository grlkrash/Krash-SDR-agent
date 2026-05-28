// tsx src/scripts/dropVoicemails.ts
//
// Cron entry: for every lead whose cold draft was approved in the last 7
// days and that has a phone number on file, draft a Twilio-ready voicemail.
// Idempotent — dropVoicemail() short-circuits if a voicemail draft already
// exists for the lead in any non-rejected status. Hard cap 50 leads/day to
// keep ElevenLabs spend bounded; 1s pacing so we don't slam Twilio Lookups.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { dropVoicemail } from '../outreach/voicemail.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DAILY_CAP = 50;
const PACING_MS = 1_000;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const main = async (): Promise<void> => {
  try {
    const cutoff = new Date(Date.now() - SEVEN_DAYS_MS);
    const candidates = await prisma.lead.findMany({
      where: {
        phoneE164: { not: null },
        doNotContact: false,
        drafts: {
          some: {
            kind: 'cold',
            status: { in: ['approved', 'sent'] },
            createdAt: { gte: cutoff },
          },
          none: { kind: 'voicemail' },
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
        await dropVoicemail(lead.id);
        ok += 1;
      } catch (err) {
        fail += 1;
        await prisma.auditLog.create({ data: {
          action: 'voicemail.failure',
          entity: 'Lead',
          entityId: lead.id,
          meta: { error: err instanceof Error ? err.message : String(err) },
        } });
      }
      await sleep(PACING_MS);
    }

    await prisma.auditLog.create({ data: {
      action: 'cron.success',
      entity: 'dropVoicemails',
      meta: { total: candidates.length, ok, fail },
    } });
    console.log(JSON.stringify({ total: candidates.length, ok, fail }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.auditLog.create({ data: {
      action: 'cron.failure',
      entity: 'dropVoicemails',
      meta: { error: message },
    } });
    throw err;
  }
};

await main();
