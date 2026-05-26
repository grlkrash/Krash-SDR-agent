// Acceptance harness for Prompt 9.4 (prep-brief generator).
//
// Finds a synced Lead that has both `hubspotCompanyId` and `enrichment`,
// stages a fresh HubSpot deal associated to that company with
// ss_product_type='select' so the commission lookup resolves, and prints
// the dealId + the local URL Sonia opens in the browser.
//
// Why an acceptance script and not a unit test:
//   The prep brief calls Claude (real spend), HubSpot (real portal), and
//   Gmail (real inbox). The acceptance check is "open the URL, see the
//   markdown render with all 7 sections" — only a live run validates that.
//   Cleanup (archive the deal, delete the prep-brief Draft) is the
//   companion `_tmpCleanupPrepBriefAcceptance.ts` script the operator
//   runs after they've eyeballed the page.
//
// Usage:
//   npx tsx src/scripts/_tmpPrepBriefAcceptance.ts
//
// Optional env overrides:
//   LEAD_ID         — pick a specific Lead; otherwise we take the first
//                     enriched lead with hubspotCompanyId set.
//   SS_PRODUCT_TYPE — defaults to 'select' (commission=$240).

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { hs, hsRetry } from '../shared/hubspot.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const requestedLeadId = process.env.LEAD_ID?.trim() ?? null;
const productType = process.env.SS_PRODUCT_TYPE?.trim() ?? 'select';

const lead = requestedLeadId === null || requestedLeadId === ''
  ? await prisma.lead.findFirst({
      where: { hubspotCompanyId: { not: null }, enrichment: { isNot: null } },
      include: { enrichment: true },
      orderBy: { createdAt: 'desc' },
    })
  : await prisma.lead.findUnique({
      where: { id: requestedLeadId },
      include: { enrichment: true },
    });

if (lead === null) throw new Error('No enriched Lead with hubspotCompanyId found — run pipeline/enrich + pipeline/hubspotSync first');
if (lead.enrichment === null) throw new Error(`Lead ${lead.id} has no enrichment`);
const hubspotCompanyId = lead.hubspotCompanyId;
if (hubspotCompanyId === null) throw new Error(`Lead ${lead.id} has no hubspotCompanyId`);

console.log('Target lead:', JSON.stringify({
  id: lead.id,
  name: lead.name,
  city: lead.city,
  state: lead.state,
  hubspotCompanyId,
  expectedProduct: lead.enrichment.expectedProduct,
}));

const dealName = `ACCEPTANCE - prep brief - ${lead.name}`;
const created = await hsRetry(() =>
  hs.crm.deals.basicApi.create({
    properties: {
      dealname: dealName,
      // qualifiedtobuy is HubSpot's default open stage — any non-closed stage
      // works here; the prep brief is stage-agnostic.
      dealstage: 'qualifiedtobuy',
      pipeline: 'default',
      ss_product_type: productType,
      amount: '2400',
    },
  }),
);

await hsRetry(() =>
  hs.crm.associations.v4.basicApi.createDefault(
    'deals',
    created.id,
    'companies',
    hubspotCompanyId,
  ),
);

const port = Number(process.env.PORT) || 3000;
const pw = process.env.QUEUE_PASSWORD ?? '';
const url = `http://localhost:${port}/prep-brief/${created.id}?pw=${encodeURIComponent(pw)}`;

console.log('\nStaged deal:', JSON.stringify({
  dealId: created.id,
  dealName,
  ss_product_type: productType,
  companyId: hubspotCompanyId,
}));
console.log('\nOpen in browser:');
console.log(url);
console.log('\nTo also send the brief by email (requires BRIEF_RECIPIENT + Gmail creds):');
console.log(`${url}&send=email`);

await prisma.$disconnect();
