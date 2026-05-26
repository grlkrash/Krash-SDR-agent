// One-off: stage a HubSpot deal for the renewal-warning acceptance check.
//
// Creates a closedwon deal with ss_renewal_date set to today+60d (UTC
// midnight, the canonical normalization HubSpot does on date properties)
// and ss_product_type=select. Associates it to the supplied
// HUBSPOT_COMPANY_ID via the v4 association API (same surface
// pipeline/hubspotSync uses for company<->contact).
//
// Usage:
//   HUBSPOT_COMPANY_ID="324407825115" \
//   DEAL_NAME="ACCEPTANCE - Families First of Florida renewal" \
//     npx tsx src/scripts/_tmpStageRenewalDeal.ts

import 'dotenv/config';
import { hs, hsRetry } from '../shared/hubspot.js';

const companyId = process.env.HUBSPOT_COMPANY_ID?.trim() ?? null;
const dealName = process.env.DEAL_NAME?.trim() ?? 'ACCEPTANCE - Renewal Test Deal';
const productType = process.env.SS_PRODUCT_TYPE?.trim() ?? 'select';
const offsetDays = Number(process.env.OFFSET_DAYS ?? '60');

if (companyId === null || companyId === '') {
  throw new Error('Set HUBSPOT_COMPANY_ID env var');
}

const MS_PER_DAY = 86_400_000;

const renewalDate = new Date(Date.now() + offsetDays * MS_PER_DAY);
// HubSpot date props normalize to UTC midnight; pass YYYY-MM-DD so the
// portal stores the same calendar date regardless of the runner's TZ.
const renewalDateStr = renewalDate.toISOString().slice(0, 10);

const created = await hsRetry(() =>
  hs.crm.deals.basicApi.create({
    properties: {
      dealname: dealName,
      dealstage: 'closedwon',
      pipeline: 'default',
      ss_renewal_date: renewalDateStr,
      ss_product_type: productType,
    },
  }),
);

await hsRetry(() =>
  hs.crm.associations.v4.basicApi.createDefault(
    'deals',
    created.id,
    'companies',
    companyId,
  ),
);

console.log(JSON.stringify({
  dealId: created.id,
  dealName,
  companyId,
  ss_renewal_date: renewalDateStr,
  ss_product_type: productType,
  dealstage: 'closedwon',
}));
