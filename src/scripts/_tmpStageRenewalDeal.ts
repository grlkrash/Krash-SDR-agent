// One-off: stage a HubSpot deal for the renewal-warning acceptance check.
//
// Preferred path (auto renewal date): set SS_CONTRACT_TERM_MONTHS and
// CLOSEDATE_OFFSET_DAYS so closedate + term lands OFFSET_DAYS before renewal.
// The daily syncDealRenewalDates job (or run it manually first) writes
// ss_renewal_date.
//
// Legacy path: set ss_renewal_date directly via OFFSET_DAYS only (omit term).
//
// Usage:
//   HUBSPOT_COMPANY_ID="324407825115" \
//   SS_CONTRACT_TERM_MONTHS=12 \
//   OFFSET_DAYS=60 \
//     npx tsx src/scripts/_tmpStageRenewalDeal.ts

import 'dotenv/config';
import {
  computeRenewalDate,
  formatHsDateOnly,
  parseContractTermMonths,
} from '../shared/dealRenewal.js';
import { hs, hsRetry } from '../shared/hubspot.js';

const companyId = process.env.HUBSPOT_COMPANY_ID?.trim() ?? null;
const dealName = process.env.DEAL_NAME?.trim() ?? 'ACCEPTANCE - Renewal Test Deal';
const productType = process.env.SS_PRODUCT_TYPE?.trim() ?? 'select';
const offsetDays = Number(process.env.OFFSET_DAYS ?? '60');
const termRaw = process.env.SS_CONTRACT_TERM_MONTHS?.trim();

if (companyId === null || companyId === '') {
  throw new Error('Set HUBSPOT_COMPANY_ID env var');
}

const MS_PER_DAY = 86_400_000;
const term = termRaw === undefined || termRaw === ''
  ? null
  : parseContractTermMonths(termRaw);

if (termRaw !== undefined && termRaw !== '' && term === null) {
  throw new Error('SS_CONTRACT_TERM_MONTHS must be 3, 6, or 12');
}

const renewalTarget = new Date(Date.now() + offsetDays * MS_PER_DAY);
const renewalDateStr = formatHsDateOnly(renewalTarget);

let closedateStr: string | undefined;
if (term !== null) {
  const y = renewalTarget.getUTCFullYear();
  const m = renewalTarget.getUTCMonth();
  const day = renewalTarget.getUTCDate();
  const closeDate = new Date(Date.UTC(y, m - term, day));
  closedateStr = formatHsDateOnly(closeDate);
  const check = formatHsDateOnly(computeRenewalDate(closeDate, term));
  if (check !== renewalDateStr) {
    throw new Error(
      `Staging math mismatch: close ${closedateStr} + ${String(term)}mo → ${check}, want ${renewalDateStr}`,
    );
  }
}

const properties: Record<string, string> = {
  dealname: dealName,
  dealstage: 'closedwon',
  pipeline: 'default',
  ss_product_type: productType,
  ss_renewal_date: renewalDateStr,
};

if (term !== null) {
  properties.ss_contract_term_months = String(term);
  if (closedateStr !== undefined) {
    properties.closedate = closedateStr;
  }
}

const created = await hsRetry(() =>
  hs.crm.deals.basicApi.create({ properties }),
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
  ss_contract_term_months: term === null ? null : String(term),
  closedate: closedateStr ?? null,
  ss_product_type: productType,
  dealstage: 'closedwon',
  note: term === null
    ? 'Set SS_CONTRACT_TERM_MONTHS for auto-sync acceptance path'
    : 'Run: npx tsx src/scripts/syncDealRenewalDates.ts then renewalWarnings',
}));
