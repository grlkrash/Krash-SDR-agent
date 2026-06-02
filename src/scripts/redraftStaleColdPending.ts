// Reject pending cold drafts missing the free-listing entry hook and regenerate
// only those leads — cheapest path (no full-queue regen).
//
//   npm run redraft:stale-cold              # dry-run
//   npm run redraft:stale-cold -- --apply   # reject + redraft

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { draftColdEmail } from '../outreach/draftCold.js';
import {
  assessColdDraftQuality,
  bodyWordCount,
  hasFreeListingEntryHook,
} from '../outreach/coldEmailQuality.js';
import { scanLeaks } from '../outreach/leakScan.js';

const APPLY = process.argv.includes('--apply');
const CONCURRENCY = Number(process.env.CONCURRENCY) || 2;
const PACING_MS = Number(process.env.PACING_MS) || 1200;
const REJECT_REASON = 'batch-redraft: free-listing prompt upgrade';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Batch redraft bypasses per-lead reject cap (operator-initiated prompt migration).
process.env.DRAFT_COLD_BATCH_REDRAFT = '1';

const pending = await prisma.draft.findMany({
  where: { kind: 'cold', status: 'pending' },
  select: {
    id: true,
    leadId: true,
    body: true,
    lead: { select: { name: true, city: true, state: true } },
  },
  orderBy: { createdAt: 'asc' },
});

const stale = pending.filter((d) => !hasFreeListingEntryHook(d.body ?? ''));

console.log(`Mode:   ${APPLY ? 'APPLY' : 'dry-run'}`);
console.log(`Pending cold drafts: ${pending.length}`);
console.log(`Missing free-listing hook: ${stale.length}\n`);

if (stale.length === 0) {
  console.log('All pending colds already have the free-listing entry offer.');
  await prisma.$disconnect();
} else if (!APPLY) {
  for (const [i, d] of stale.entries()) {
    console.log(`${i + 1}. ${d.lead.name} (${d.lead.city}, ${d.lead.state}) — ${d.id}`);
  }
  console.log('\nRe-run with: npm run redraft:stale-cold -- --apply');
  await prisma.$disconnect();
} else {
  let rejected = 0;
  let ok = 0;
  let skipped = 0;
  let fail = 0;

  const leadIds = [...new Set(stale.map((d) => d.leadId))];

  for (const d of stale) {
    await prisma.draft.update({
      where: { id: d.id },
      data: { status: 'rejected', rejectReason: REJECT_REASON },
    });
    rejected += 1;
    await prisma.auditLog.create({
      data: {
        action: 'draft.batch-redraft-reject',
        entity: 'Draft',
        entityId: d.id,
        meta: { leadId: d.leadId, reason: REJECT_REASON },
      },
    });
  }

  console.log(`Rejected ${rejected} stale draft(s). Redrafting ${leadIds.length} lead(s)…\n`);

  for (let i = 0; i < leadIds.length; i += CONCURRENCY) {
    const batch = leadIds.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (leadId) => {
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: { name: true, city: true, state: true },
      });
      try {
        const draftId = await draftColdEmail(leadId);
        if (draftId === null) {
          console.log(`SKIP  ${lead?.name ?? leadId} — draftColdEmail returned null`);
          skipped += 1;
          return;
        }
        const draft = await prisma.draft.findUnique({
          where: { id: draftId },
          select: {
            body: true,
            subject: true,
            personalizationPct: true,
            lead: { select: { name: true, city: true, state: true, services: true } },
          },
        });
        if (draft === null) {
          fail += 1;
          return;
        }
        const wc = bodyWordCount(draft.body);
        const hook = hasFreeListingEntryHook(draft.body);
        const quality = assessColdDraftQuality(draft.subject ?? '', draft.body, {
          facilityName: draft.lead.name,
          city: draft.lead.city,
          state: draft.lead.state,
          services: draft.lead.services,
        });
        const leaks = scanLeaks(draft.body, [lead?.name ?? '']);
        const status = hook && quality.ok && leaks.length === 0 ? 'OK' : 'WARN';
        console.log(
          `${status}  ${lead?.name} — ${wc}w, hook=${hook ? 'yes' : 'NO'}, quality=${quality.ok ? 'ok' : quality.body.issues.join(',')}`,
        );
        if (draftId !== null) ok += 1;
      } catch (err) {
        fail += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`FAIL  ${lead?.name ?? leadId} — ${msg}`);
      }
    }));
    if (i + CONCURRENCY < leadIds.length) await sleep(PACING_MS);
  }

  const after = await prisma.draft.findMany({
    where: { kind: 'cold', status: 'pending' },
    select: { body: true },
  });
  const stillStale = after.filter((d) => !hasFreeListingEntryHook(d.body ?? '')).length;

  console.log('\n=== summary ===');
  console.log(JSON.stringify({ rejected, redrafted: leadIds.length, ok, skipped, fail, stillStale }, null, 2));

  await prisma.auditLog.create({
    data: {
      action: 'draft.batch-redraft.complete',
      entity: 'script',
      entityId: 'redraftStaleColdPending',
      meta: { rejected, ok, skipped, fail, stillStale },
    },
  });

  await prisma.$disconnect();
  if (stillStale > 0 || fail > 0) process.exitCode = 1;
}
