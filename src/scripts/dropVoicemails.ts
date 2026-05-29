// tsx src/scripts/dropVoicemails.ts
//
// Cron entry: draft a consent-gated vm-1 for leads who opted in to phone
// contact (Lead.priorWrittenConsent) after a sent reactivation email.
// Renewals are live-call only (/renewals-call). Cold vm is NOT triggered here.
//
// Idempotent — dropVoicemail() short-circuits if a voicemail draft already
// exists. Hard cap 50/day; 1s pacing for Twilio Lookups.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { dropVoicemail, type VoicemailTrigger } from '../outreach/voicemail.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DAILY_CAP = 50;
const PACING_MS = 1_000;
const CONSENT_TRIGGER_KINDS = ['reactivation'] as const;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const resolveTrigger = async (
  leadId: string,
  cutoff: Date,
): Promise<VoicemailTrigger | null> => {
  const sent = await prisma.draft.findFirst({
    where: {
      leadId,
      kind: { in: [...CONSENT_TRIGGER_KINDS] },
      status: { in: ['sent', 'auto-sent'] },
      sentAt: { gte: cutoff },
    },
    orderBy: { sentAt: 'desc' },
    select: { kind: true },
  });
  if (sent === null) return null;
  if (sent.kind === 'reactivation') return 'reactivation';
  return null;
};

const main = async (): Promise<void> => {
  try {
    const cutoff = new Date(Date.now() - THIRTY_DAYS_MS);
    const candidates = await prisma.lead.findMany({
      where: {
        priorWrittenConsent: true,
        phoneE164: { not: null },
        doNotContact: false,
        drafts: {
          some: {
            kind: { in: [...CONSENT_TRIGGER_KINDS] },
            status: { in: ['sent', 'auto-sent'] },
            sentAt: { gte: cutoff },
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
    let skipped = 0;
    for (const lead of candidates) {
      const trigger = await resolveTrigger(lead.id, cutoff);
      if (trigger === null) {
        skipped += 1;
        continue;
      }
      try {
        await dropVoicemail(lead.id, trigger);
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
      meta: { total: candidates.length, ok, fail, skipped, mode: 'consent-gated-post-sale' },
    } });
    console.log(JSON.stringify({ total: candidates.length, ok, fail, skipped }));
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
