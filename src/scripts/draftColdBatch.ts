// tsx src/scripts/draftColdBatch.ts

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { draftColdEmail } from '../outreach/draftCold.js';
import { isReadyForColdEmailDraft } from '../outreach/outboundSequence.js';
import { isExcludedFromCold } from '../shared/exclusion.js';
import { guessEmail } from '../shared/guessEmail.js';

const BATCH_SIZE = 30;
const CONCURRENCY = 3;
const BATCH_SLEEP_MS = 1000;
// Over-fetch because we filter Suppression + computed targetEmail in JS.
const CANDIDATE_OVERFETCH = BATCH_SIZE * 4;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

try {
  const suppressedRows = await prisma.suppression.findMany({
    where: { email: { not: '' } },
    select: { email: true },
  });
  const suppressedEmails = new Set(suppressedRows.map((s) => s.email));

  const candidates = await prisma.lead.findMany({
    where: {
      doNotContact: false,
      enrichment: { isNot: null },
      drafts: { none: { kind: 'cold', status: { not: 'rejected' } } },
      OR: [
        { enrichment: { ownerEmail: { not: null } } },
        { website: { not: null } },
      ],
    },
    include: { enrichment: true },
    take: CANDIDATE_OVERFETCH,
  });

  const eligible: string[] = [];
  for (const lead of candidates) {
    if (lead.enrichment === null) continue;
    if (isExcludedFromCold(lead)) continue;
    const targetEmail = lead.enrichment.ownerEmail
      ?? guessEmail(lead.enrichment.ownerName, lead.website);
    if (targetEmail === null) continue;
    if (suppressedEmails.has(targetEmail)) continue;
    if (!(await isReadyForColdEmailDraft(lead.id))) continue;
    eligible.push(lead.id);
    if (eligible.length >= BATCH_SIZE) break;
  }

  let ok = 0;
  let skipped = 0;
  let fail = 0;
  for (let i = 0; i < eligible.length; i += CONCURRENCY) {
    const batch = eligible.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (leadId) => {
      try {
        const draftId = await draftColdEmail(leadId);
        if (draftId === null) skipped += 1;
        else ok += 1;
      } catch (err) {
        fail += 1;
        await prisma.auditLog.create({ data: {
          action: 'draftCold.failure',
          entity: 'lead',
          entityId: leadId,
          meta: { error: err instanceof Error ? err.message : String(err) },
        } });
      }
    }));
    if (i + CONCURRENCY < eligible.length) await sleep(BATCH_SLEEP_MS);
  }

  await prisma.auditLog.create({ data: {
    action: 'cron.success',
    entity: 'draftColdBatch',
    meta: { total: eligible.length, ok, skipped, fail },
  } });
  console.log(JSON.stringify({ total: eligible.length, ok, skipped, fail }));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({ data: {
    action: 'cron.failure',
    entity: 'draftColdBatch',
    meta: { error: message },
  } });
  throw err;
}
