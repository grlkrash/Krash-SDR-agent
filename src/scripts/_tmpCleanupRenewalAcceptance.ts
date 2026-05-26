// One-off: clean up artifacts created by the renewal-warning acceptance
// check. Archives the HubSpot test deal and deletes the resulting Draft
// so the /queue stays clean. Idempotent — missing rows are no-ops.
//
// Usage:
//   DEAL_ID="327014281936" DRAFT_ID="cmpmomv42000039w442abl4pz" \
//     npx tsx src/scripts/_tmpCleanupRenewalAcceptance.ts

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { hs, hsRetry } from '../shared/hubspot.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const dealId = process.env.DEAL_ID?.trim() ?? null;
const draftId = process.env.DRAFT_ID?.trim() ?? null;

if (dealId !== null && dealId !== '') {
  try {
    await hsRetry(() => hs.crm.deals.basicApi.archive(dealId));
    console.log(JSON.stringify({ archived: 'deal', id: dealId }));
  } catch (err) {
    console.log(JSON.stringify({
      archived: 'deal',
      id: dealId,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}

if (draftId !== null && draftId !== '') {
  const deleted = await prisma.draft.deleteMany({ where: { id: draftId } });
  console.log(JSON.stringify({ deleted: 'draft', id: draftId, count: deleted.count }));
}

await prisma.$disconnect();
