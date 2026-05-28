// Keeps HubSpot deal ss_renewal_date in sync with closedate + ss_contract_term_months.
// Run daily before renewalWarnings so the 60-day window query stays accurate
// without hand-maintaining renewal dates.
//
// Operator contract: set ss_contract_term_months (3, 6, or 12) when a deal
// closes. On each renewal, update closedate to the new contract start so the
// next ss_renewal_date is recomputed automatically.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/deals/models/Filter.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import {
  computeRenewalDate,
  formatHsDateOnly,
  hsDateOnlyEqual,
  parseContractTermMonths,
  parseHsDate,
} from '../shared/dealRenewal.js';

const CLOSED_WON_STAGE = 'closedwon';
const SEARCH_PAGE_SIZE = 100;
const PACING_MS = 100;
const DEAL_PROPERTIES = [
  'dealname',
  'closedate',
  'ss_renewal_date',
  'ss_contract_term_months',
];

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const audit = (
  action: string,
  entityId: string | null,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'deal', entityId, meta } });

interface DealRow {
  id: string;
  dealname: string | null;
  closedate: string | null;
  renewalDate: string | null;
  contractTermMonths: string | null;
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
        closedate: d.properties.closedate ?? null,
        renewalDate: d.properties.ss_renewal_date ?? null,
        contractTermMonths: d.properties.ss_contract_term_months ?? null,
      });
    }
    const next = res.paging?.next?.after;
    if (next === undefined || next === '') break;
    after = next;
    await sleep(PACING_MS);
  }
  return rows;
};

export const syncDealRenewalDates = async (): Promise<void> => {
  const deals = await fetchClosedWonDeals();
  let updated = 0;
  let skipped = 0;
  let unchanged = 0;

  for (const deal of deals) {
    const term = parseContractTermMonths(deal.contractTermMonths);
    if (term === null) {
      skipped += 1;
      continue;
    }

    const closeDate = parseHsDate(deal.closedate);
    if (closeDate === null) {
      await audit('syncDealRenewalDates.skip-no-closedate', deal.id, {
        dealname: deal.dealname,
        contractTermMonths: term,
      });
      skipped += 1;
      continue;
    }

    const expected = computeRenewalDate(closeDate, term);
    const expectedStr = formatHsDateOnly(expected);
    const stored = parseHsDate(deal.renewalDate);

    if (stored !== null && hsDateOnlyEqual(stored, expected)) {
      unchanged += 1;
      continue;
    }

    try {
      await hsRetry(() =>
        hs.crm.deals.basicApi.update(deal.id, {
          properties: { ss_renewal_date: expectedStr },
        }),
      );
      await audit('syncDealRenewalDates.updated', deal.id, {
        dealname: deal.dealname,
        contractTermMonths: term,
        closedate: formatHsDateOnly(closeDate),
        previousRenewalDate: stored === null ? null : formatHsDateOnly(stored),
        ss_renewal_date: expectedStr,
      });
      updated += 1;
    } catch (err) {
      await audit('syncDealRenewalDates.failure', deal.id, {
        error: err instanceof Error ? err.message : String(err),
        contractTermMonths: term,
      });
    }
    await sleep(PACING_MS);
  }

  await audit('syncDealRenewalDates.run', null, {
    candidates: deals.length,
    updated,
    unchanged,
    skipped,
  });
};
