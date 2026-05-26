// One-off: survey all open HubSpot deals (any age) to see which could become
// reactivation candidates after their hs_lastmodifieddate ages past 30d.
// HubSpot manages hs_lastmodifieddate and bumps it on every write, so we
// cannot synthesize a stale deal directly — the acceptance verifier must
// either find an already-stale deal or run a 0-day-cutoff variant.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/deals/models/Filter.js';
import { hs, hsRetry } from '../shared/hubspot.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const MS_PER_DAY = 86_400_000;
const PAGE_SIZE = 100;
const MAX_RESULTS = 30;

const now = Date.now();

const res = await hsRetry(() =>
  hs.crm.deals.searchApi.doSearch({
    filterGroups: [{
      filters: [
        { propertyName: 'dealstage', operator: FilterOperatorEnum.NotIn, values: ['closedwon', 'closedlost'] },
      ],
    }],
    properties: ['dealname', 'dealstage', 'hs_lastmodifieddate'],
    limit: PAGE_SIZE,
  }),
);

console.log(JSON.stringify({ totalOpenDeals: res.total }));

let printed = 0;
for (const d of res.results) {
  if (printed >= MAX_RESULTS) break;
  const detail = await hsRetry(() =>
    hs.crm.deals.basicApi.getById(d.id, ['dealname', 'dealstage', 'hs_lastmodifieddate'], undefined, ['companies']),
  );
  const companyId = detail.associations?.companies?.results[0]?.id ?? null;
  let leadId: string | null = null;
  let leadName: string | null = null;
  if (companyId !== null) {
    const lead = await prisma.lead.findFirst({
      where: { hubspotCompanyId: companyId },
      select: { id: true, name: true },
    });
    leadId = lead?.id ?? null;
    leadName = lead?.name ?? null;
  }
  const lastMod = d.properties.hs_lastmodifieddate ?? null;
  console.log(JSON.stringify({
    dealId: d.id,
    dealname: d.properties.dealname,
    dealstage: d.properties.dealstage,
    hs_lastmodifieddate: lastMod,
    daysAgo: lastMod ? Math.round((now - Date.parse(lastMod)) / MS_PER_DAY) : null,
    companyId,
    leadId,
    leadName,
  }));
  printed += 1;
}

await prisma.$disconnect();
