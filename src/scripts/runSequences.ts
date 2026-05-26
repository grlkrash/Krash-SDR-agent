// tsx src/scripts/runSequences.ts
//
// Cron entry: advance every eligible follow-up sequence by at most one step.
// Eligibility = a cold draft was sent more than 3 days ago AND no 'replied'
// draft exists for that lead. The sequencer itself enforces the per-step
// cadence (3/4/7/16 business days) — this query just filters out leads that
// can't possibly be due yet, so we don't waste DB roundtrips. 500ms pacing
// keeps Gmail send quota and HubSpot engagement-create rate limits headroom.
// Capped at 100 leads per run; backlog drains across cron ticks.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { runSequenceStep } from '../outreach/sequencer.js';

const PACING_MS = 500;
const MAX_PER_RUN = 100;
const COLD_AGE_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const main = async (): Promise<void> => {
  if (!process.env.GMAIL_REFRESH_TOKEN) {
    await prisma.auditLog.create({ data: {
      action: 'cron.skipped',
      entity: 'runSequences',
      entityId: null,
      meta: { reason: 'GMAIL_REFRESH_TOKEN not set — manual-send phase' },
    } });
    console.log(JSON.stringify({ status: 'skipped', reason: 'no Gmail credentials yet' }));
    return;
  }

  try {
    const cutoff = new Date(Date.now() - COLD_AGE_DAYS * MS_PER_DAY);

    const coldRows = await prisma.draft.findMany({
      where: { kind: 'cold', sentAt: { lt: cutoff } },
      select: { leadId: true },
      distinct: ['leadId'],
    });
    const candidateLeadIds = coldRows.map((r) => r.leadId);

    const repliedRows = candidateLeadIds.length === 0
      ? []
      : await prisma.draft.findMany({
          where: { leadId: { in: candidateLeadIds }, kind: 'replied' },
          select: { leadId: true },
          distinct: ['leadId'],
        });
    const repliedSet = new Set(repliedRows.map((r) => r.leadId));

    const eligible = candidateLeadIds
      .filter((id) => !repliedSet.has(id))
      .slice(0, MAX_PER_RUN);

    let ok = 0;
    let fail = 0;
    for (const leadId of eligible) {
      try {
        await runSequenceStep(leadId);
        ok += 1;
      } catch (err) {
        fail += 1;
        await prisma.auditLog.create({ data: {
          action: 'sequencer.failure',
          entity: 'Lead',
          entityId: leadId,
          meta: { error: err instanceof Error ? err.message : String(err) },
        } });
      }
      await sleep(PACING_MS);
    }

    await prisma.auditLog.create({ data: {
      action: 'cron.success',
      entity: 'runSequences',
      meta: { candidates: candidateLeadIds.length, eligible: eligible.length, ok, fail },
    } });
    console.log(JSON.stringify({
      candidates: candidateLeadIds.length,
      eligible: eligible.length,
      ok,
      fail,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.auditLog.create({ data: {
      action: 'cron.failure',
      entity: 'runSequences',
      meta: { error: message },
    } });
    throw err;
  }
};

await main();
