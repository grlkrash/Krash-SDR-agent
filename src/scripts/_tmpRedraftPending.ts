// One-off: reject all pending cold drafts and regenerate under the current
// value-packed prompt (market pain + SS identity + word-count gates).
//
// Usage:
//   npx tsx src/scripts/_tmpRedraftPending.ts              # dry-run
//   APPLY=1 npx tsx src/scripts/_tmpRedraftPending.ts      # reject + redraft all
//   APPLY=1 LIMIT=5 npx tsx src/scripts/_tmpRedraftPending.ts

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { draftColdEmail } from '../outreach/draftCold.js';
import {
  assessColdEmailQuality,
  bodyWordCount,
  COLD_BODY_MIN_WORDS,
  COLD_BODY_TARGET_MIN,
} from '../outreach/coldEmailQuality.js';
import { scanLeaks } from '../outreach/leakScan.js';

const APPLY = process.env.APPLY === '1';
const LIMIT = process.env.LIMIT !== undefined ? Number(process.env.LIMIT) : null;
const CONCURRENCY = Number(process.env.CONCURRENCY) || 2;
const PACING_MS = Number(process.env.PACING_MS) || 1500;
const REJECT_REASON = 'batch-redraft: value-packed prompt upgrade';
const MAX_REJECTS_PER_LEAD = 3;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const pending = await prisma.draft.findMany({
  where: { kind: 'cold', status: 'pending' },
  select: {
    id: true,
    leadId: true,
    lead: { select: { name: true, city: true, state: true } },
  },
  orderBy: { createdAt: 'asc' },
});

const targets = LIMIT !== null && !Number.isNaN(LIMIT) ? pending.slice(0, LIMIT) : pending;

console.log(`Mode:     ${APPLY ? 'APPLY (reject + redraft)' : 'dry-run'}`);
console.log(`Pending:  ${pending.length} cold draft(s)`);
console.log(`Targets:  ${targets.length}\n`);

if (targets.length === 0) {
  console.log('Nothing to redraft.');
  await prisma.$disconnect();
} else if (!APPLY) {
  for (const [i, d] of targets.entries()) {
    console.log(`${i + 1}. ${d.lead.name} (${d.lead.city}, ${d.lead.state}) — draft ${d.id}`);
  }
  console.log('\nDry-run only — re-run with APPLY=1 to reject and regenerate.');
  await prisma.$disconnect();
} else {
  let rejected = 0;
  let ok = 0;
  let skipped = 0;
  let fail = 0;
  let leakFail = 0;
  const wordCounts: number[] = [];
  const qualityFails: string[] = [];

  const toRedraft: string[] = [];

  for (const d of targets) {
    const priorRejects = await prisma.draft.count({
      where: { leadId: d.leadId, kind: 'cold', status: 'rejected' },
    });
    if (priorRejects >= MAX_REJECTS_PER_LEAD - 1) {
      console.log(`SKIP reject cap: ${d.lead.name} (${priorRejects} prior rejects)`);
      skipped += 1;
      continue;
    }

    await prisma.draft.update({
      where: { id: d.id },
      data: { status: 'rejected', rejectReason: REJECT_REASON },
    });
    rejected += 1;
    toRedraft.push(d.leadId);

    await prisma.auditLog.create({
      data: {
        action: 'draft.batch-redraft-reject',
        entity: 'Draft',
        entityId: d.id,
        meta: { leadId: d.leadId, reason: REJECT_REASON },
      },
    });
  }

  const uniqueLeadIds = [...new Set(toRedraft)];

  console.log(`Rejected ${rejected} pending draft(s). Redrafting ${uniqueLeadIds.length} lead(s)…\n`);

  for (let i = 0; i < uniqueLeadIds.length; i += CONCURRENCY) {
    const batch = uniqueLeadIds.slice(i, i + CONCURRENCY);
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
          select: { body: true, personalizationPct: true },
        });
        if (draft === null) {
          fail += 1;
          return;
        }

        const wc = bodyWordCount(draft.body);
        wordCounts.push(wc);
        const quality = assessColdEmailQuality(draft.body);
        const leaks = scanLeaks(draft.body, [lead?.name ?? '']);

        if (leaks.length > 0) {
          leakFail += 1;
          console.log(`LEAK  ${lead?.name} — ${leaks.map((h) => h.label).join(', ')}`);
        }
        if (!quality.ok) {
          qualityFails.push(`${lead?.name}: ${quality.issues.join(', ')} (${wc}w)`);
        }

        console.log(
          `OK    ${lead?.name} — ${wc}w, ${draft.personalizationPct ?? '?'}% personalisation`,
        );
        ok += 1;
      } catch (err) {
        fail += 1;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`FAIL  ${lead?.name ?? leadId} — ${msg}`);
        await prisma.auditLog.create({
          data: {
            action: 'draft.batch-redraft.failure',
            entity: 'lead',
            entityId: leadId,
            meta: { error: msg },
          },
        });
      }
    }));
    if (i + CONCURRENCY < uniqueLeadIds.length) await sleep(PACING_MS);
  }

  wordCounts.sort((a, b) => a - b);
  const avg = wordCounts.length > 0
    ? wordCounts.reduce((s, n) => s + n, 0) / wordCounts.length
    : 0;

  console.log('\n=== summary ===');
  console.log(JSON.stringify({
    rejected,
    redraftTargets: uniqueLeadIds.length,
    ok,
    skipped,
    fail,
    leakFail,
    qualityFail: qualityFails.length,
  }, null, 2));

  if (wordCounts.length > 0) {
    console.log('\n=== word counts (new pending colds) ===');
    console.log({
      n: wordCounts.length,
      min: wordCounts[0],
      median: wordCounts[Math.floor(wordCounts.length / 2)],
      max: wordCounts[wordCounts.length - 1],
      avg: Number(avg.toFixed(1)),
      underMin: wordCounts.filter((w) => w < COLD_BODY_MIN_WORDS).length,
      underTarget: wordCounts.filter((w) => w < COLD_BODY_TARGET_MIN).length,
    });
  }

  if (qualityFails.length > 0) {
    console.log('\n=== quality failures ===');
    for (const line of qualityFails.slice(0, 10)) console.log(`  ${line}`);
    if (qualityFails.length > 10) console.log(`  … and ${qualityFails.length - 10} more`);
  }

  // Acceptance: all new pending colds from this run should pass quality + leak gates
  const newPending = await prisma.draft.findMany({
    where: { kind: 'cold', status: 'pending' },
    select: { body: true, lead: { select: { name: true } } },
  });
  let acceptQuality = 0;
  let acceptLeak = 0;
  for (const d of newPending) {
    if (!assessColdEmailQuality(d.body).ok) acceptQuality += 1;
    if (scanLeaks(d.body, [d.lead.name]).length > 0) acceptLeak += 1;
  }
  console.log('\n=== acceptance (all pending colds in queue) ===');
  console.log({
    pendingTotal: newPending.length,
    qualityFailures: acceptQuality,
    leakFailures: acceptLeak,
    pass: acceptQuality === 0 && acceptLeak === 0,
  });

  await prisma.auditLog.create({
    data: {
      action: 'draft.batch-redraft.complete',
      entity: 'script',
      entityId: '_tmpRedraftPending',
      meta: {
        rejected,
        ok,
        skipped,
        fail,
        leakFail,
        qualityFail: qualityFails.length,
        wordCountMedian: wordCounts[Math.floor(wordCounts.length / 2)] ?? null,
      },
    },
  });

  await prisma.$disconnect();
  if (fail > 0 || leakFail > 0 || acceptQuality > 0 || acceptLeak > 0) {
    process.exitCode = 1;
  }
}
