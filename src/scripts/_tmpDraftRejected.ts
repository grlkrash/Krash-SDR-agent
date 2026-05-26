// One-off: re-draft the N most recently rejected cold drafts.
// Picks leads whose latest cold draft is 'rejected' (= needs re-draft) and runs
// draftColdEmail again with the current prompt. Prints each fresh draft and
// runs the same leak scan as _tmpDraftOne.ts.
//
// Usage:
//   npx tsx src/scripts/_tmpDraftRejected.ts            # defaults to 3
//   LIMIT=5 npx tsx src/scripts/_tmpDraftRejected.ts

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { draftColdEmail } from '../outreach/draftCold.js';
import { scanLeaks } from '../outreach/leakScan.js';

const DEFAULT_LIMIT = 3;
const LIMIT = Number(process.env.LIMIT) || DEFAULT_LIMIT;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const targets = await prisma.draft.findMany({
  where: {
    kind: 'cold',
    status: 'rejected',
    lead: {
      enrichment: { isNot: null },
      drafts: { none: { kind: 'cold', status: { not: 'rejected' } } },
    },
  },
  orderBy: { createdAt: 'desc' },
  take: LIMIT,
  include: { lead: { include: { enrichment: true } } },
});

console.log(`Found ${targets.length} lead(s) with rejected-only cold drafts (limit ${LIMIT}).\n`);

if (targets.length === 0) {
  console.log('Nothing to re-draft. (No rejected cold drafts without a newer non-rejected one.)');
  await prisma.$disconnect();
} else {
  let okCount = 0;
  let leakCount = 0;
  let failCount = 0;

  for (const [i, rejected] of targets.entries()) {
    const lead = rejected.lead;
    console.log(`\n=== ${i + 1}/${targets.length} ===`);
    console.log(`Lead:       ${lead.name} (${lead.city}, ${lead.state})`);
    console.log(`Lead id:    ${lead.id}`);
    console.log(`Tier:       ${lead.enrichment?.expectedProduct ?? '(unknown)'}  [internal — never in email]`);
    console.log(`Rejected:   draft ${rejected.id} (rejected at ${rejected.createdAt.toISOString()})`);
    if (rejected.rejectReason !== null) console.log(`Reason:     ${rejected.rejectReason}`);

    try {
      const draftId = await draftColdEmail(lead.id);
      if (draftId === null) {
        console.log('Result:     draftColdEmail returned null (no email, suppressed, or score-too-low). See AuditLog.');
        failCount += 1;
        continue;
      }
      const draft = await prisma.draft.findUnique({ where: { id: draftId } });
      if (draft === null) throw new Error(`draft ${draftId} missing after create`);

      console.log(`New draft:  ${draft.id}`);
      console.log(`Subject:    ${draft.subject ?? '(none)'}`);
      console.log(`Personal.:  ${draft.personalizationPct ?? '(none)'}%`);
      console.log(`Facts:      ${JSON.stringify(draft.specificFacts)}`);
      console.log(`\n--- Body ---\n${draft.body}\n--- End ---`);

      const hits = scanLeaks(draft.body, [lead.name]);
      if (hits.length === 0) {
        console.log('Leak scan:  clean.');
        okCount += 1;
      } else {
        console.log('Leak scan:  FAILED');
        for (const h of hits) console.log(`  - ${h.label}: "${h.match}"`);
        leakCount += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`Error:      ${msg}`);
      failCount += 1;
    }
  }

  console.log(`\n=== summary ===`);
  console.log(`total:    ${targets.length}`);
  console.log(`clean:    ${okCount}`);
  console.log(`leaks:    ${leakCount}`);
  console.log(`failures: ${failCount}`);

  await prisma.$disconnect();
  if (leakCount > 0 || failCount > 0) process.exitCode = 1;
}
