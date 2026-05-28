// One-shot / occasional: set ss_contract_term_months on closed-won deals that
// are missing it, then run syncDealRenewalDates to derive ss_renewal_date.
//
// Default term is 12 months. Override per run:
//   DEFAULT_TERM_MONTHS=6 CONFIRM=yes npx tsx src/scripts/backfillContractTerms.ts
//
// Dry-run (no writes):
//   npx tsx src/scripts/backfillContractTerms.ts

import 'dotenv/config';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/deals/models/Filter.js';
import {
  DEFAULT_CONTRACT_TERM_MONTHS,
  parseContractTermMonths,
} from '../shared/dealRenewal.js';
import { hs, hsRetry } from '../shared/hubspot.js';

const CLOSED_WON_STAGE = 'closedwon';
const SEARCH_PAGE_SIZE = 100;
const PACING_MS = 100;
const DEAL_PROPERTIES = ['dealname', 'ss_contract_term_months', 'closedate'];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const confirm = process.env.CONFIRM?.trim() === 'yes';
const termRaw = process.env.DEFAULT_TERM_MONTHS?.trim() ?? String(DEFAULT_CONTRACT_TERM_MONTHS);
const defaultTerm = parseContractTermMonths(termRaw);
if (defaultTerm === null) {
  throw new Error('DEFAULT_TERM_MONTHS must be 3, 6, or 12');
}

interface DealRow {
  id: string;
  dealname: string | null;
  contractTermMonths: string | null;
  closedate: string | null;
}

const fetchClosedWonDeals = async (): Promise<DealRow[]> => {
  const rows: DealRow[] = [];
  let after: string | undefined = undefined;
  while (true) {
    const res = await hsRetry(() =>
      hs.crm.deals.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'dealstage',
            operator: FilterOperatorEnum.Eq,
            value: CLOSED_WON_STAGE,
          }],
        }],
        properties: DEAL_PROPERTIES,
        limit: SEARCH_PAGE_SIZE,
        after: after ?? '',
      }),
    );
    for (const d of res.results) {
      rows.push({
        id: d.id,
        dealname: d.properties.dealname ?? null,
        contractTermMonths: d.properties.ss_contract_term_months ?? null,
        closedate: d.properties.closedate ?? null,
      });
    }
    const next = res.paging?.next?.after;
    if (next === undefined || next === '') break;
    after = next;
    await sleep(PACING_MS);
  }
  return rows;
};

const deals = await fetchClosedWonDeals();
const missing = deals.filter(
  (d) => parseContractTermMonths(d.contractTermMonths) === null,
);

console.log(JSON.stringify({
  closedWonTotal: deals.length,
  missingTerm: missing.length,
  defaultTermMonths: defaultTerm,
  confirm,
}));

if (!confirm) {
  console.log(JSON.stringify({
    hint: 'Re-run with CONFIRM=yes to write ss_contract_term_months on missing deals',
  }));
} else {
  let updated = 0;
  for (const deal of missing) {
    await hsRetry(() =>
      hs.crm.deals.basicApi.update(deal.id, {
        properties: { ss_contract_term_months: String(defaultTerm) },
      }),
    );
    updated += 1;
    console.log(JSON.stringify({
      status: 'updated',
      dealId: deal.id,
      dealname: deal.dealname,
      closedate: deal.closedate,
      ss_contract_term_months: String(defaultTerm),
    }));
    await sleep(PACING_MS);
  }
  console.log(JSON.stringify({ status: 'done', updated }));
}
