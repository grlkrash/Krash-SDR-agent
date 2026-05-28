// Keeps HubSpot deal ss_renewal_date in sync with closedate + ss_contract_term_months.
// Run daily before renewalWarnings so the 60-day window query stays accurate
// without hand-maintaining renewal dates.
//
// Operator contract: close the deal in HubSpot (closedate). Missing
// ss_contract_term_months defaults to 12 on each sync — no paid HubSpot
// workflows. For 3- or 6-month contracts, set the term on the deal once.
// On each renewal, update closedate to the new contract start.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/deals/models/Filter.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import {
  computeRenewalDate,
  DEFAULT_CONTRACT_TERM_MONTHS,
  formatHsDateOnly,
  hsDateOnlyEqual,
  parseContractTermMonths,
  parseHsDate,
  type ContractTermMonths,
} from '../shared/dealRenewal.js';

const resolveDefaultTerm = (): ContractTermMonths => {
  const raw = process.env.SSA_DEFAULT_CONTRACT_TERM_MONTHS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_CONTRACT_TERM_MONTHS;
  return parseContractTermMonths(raw) ?? DEFAULT_CONTRACT_TERM_MONTHS;
};

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
  const defaultTerm = resolveDefaultTerm();
  const deals = await fetchClosedWonDeals();
  let updated = 0;
  let skipped = 0;
  let unchanged = 0;
  let termDefaulted = 0;

  for (const deal of deals) {
    const closeDate = parseHsDate(deal.closedate);
    if (closeDate === null) {
      await audit('syncDealRenewalDates.skip-no-closedate', deal.id, {
        dealname: deal.dealname,
      });
      skipped += 1;
      continue;
    }

    let term = parseContractTermMonths(deal.contractTermMonths);
    const appliedDefaultTerm = term === null;
    if (term === null) {
      term = defaultTerm;
      termDefaulted += 1;
    }

    const expected = computeRenewalDate(closeDate, term);
    const expectedStr = formatHsDateOnly(expected);
    const stored = parseHsDate(deal.renewalDate);
    const termOnDeal = parseContractTermMonths(deal.contractTermMonths);
    const termMatches = termOnDeal === term;
    const renewalMatches = stored !== null && hsDateOnlyEqual(stored, expected);

    if (termMatches && renewalMatches) {
      unchanged += 1;
      continue;
    }

    const properties: Record<string, string> = { ss_renewal_date: expectedStr };
    if (!termMatches) {
      properties.ss_contract_term_months = String(term);
    }

    try {
      await hsRetry(() =>
        hs.crm.deals.basicApi.update(deal.id, { properties }),
      );
      await audit(
        appliedDefaultTerm
          ? 'syncDealRenewalDates.defaulted-term-and-renewal'
          : 'syncDealRenewalDates.updated',
        deal.id,
        {
          dealname: deal.dealname,
          contractTermMonths: term,
          appliedDefaultTerm,
          closedate: formatHsDateOnly(closeDate),
          previousRenewalDate: stored === null ? null : formatHsDateOnly(stored),
          ss_renewal_date: expectedStr,
        },
      );
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
    termDefaulted,
    defaultTermMonths: defaultTerm,
  });
};
