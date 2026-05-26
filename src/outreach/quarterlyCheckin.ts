// Quarterly check-in generator. Pulls closed-won deals from HubSpot whose
// closedate falls in one of three ~90/180/270d windows, finds the matching
// Lead, and drafts a warm CSM-style check-in via Claude.
//
// "Look up lead via company domain" (Prompt 9.1) is implemented as a
// hubspotCompanyId join: companies are upserted by domain in
// pipeline/hubspotSync, so Lead.hubspotCompanyId is the canonical
// domain-anchored FK. Skipping the redundant company GET cuts one HubSpot
// call per deal and yields the same lead.
//
// Per-deal try/catch keeps a single bad lead from killing the run; failures
// are surfaced via AuditLog so the cron entry's success row stays meaningful.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/deals/models/Filter.js';
import { z } from 'zod';
import { claude, extractJSON } from '../shared/claude.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import {
  QUARTERLY_CHECKIN_SYSTEM,
  buildQuarterlyUser,
} from '../prompts/quarterlyCheckin.js';

const cached = (text: string): Array<TextBlockParam> => [
  { type: 'text', text, cache_control: { type: 'ephemeral' } },
];

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 512;
const TEMPERATURE = 0.6;

const MS_PER_DAY = 86_400_000;
// ~90/180/270 days post-close, each ±5d wide. Daily cron + 30d cooldown
// means each lead gets one realistic shot per quarter without race risk.
const WINDOWS_DAYS: ReadonlyArray<readonly [number, number]> = [
  [85, 95],
  [175, 185],
  [265, 275],
];
const COOLDOWN_DAYS = 30;
const SEARCH_PAGE_SIZE = 100;
const PACING_MS = 100;
const DEAL_PROPERTIES = ['dealname', 'closedate', 'ss_product_type', 'dealstage'];
const CLOSED_WON_STAGE = 'closedwon';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const GenSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

const audit = (
  action: string,
  entityId: string | null,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'deal', entityId, meta } });

// HubSpot returns dates as ISO strings on most v3 endpoints; legacy/system
// properties occasionally arrive as Unix-ms. Mirror parseHsDate from
// pipeline/scoring so callers never get a sentinel-value land mine.
const parseHsDate = (raw: string | null | undefined): Date | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso)) return new Date(iso);
  const num = Number(raw);
  if (!Number.isNaN(num) && num > 0) return new Date(num);
  return null;
};

interface DealRow {
  id: string;
  closedate: string | null;
  dealname: string | null;
  productType: string | null;
}

const fetchClosedWonDealsInWindow = async (
  windowStartMs: number,
  windowEndMs: number,
): Promise<DealRow[]> => {
  const rows: DealRow[] = [];
  let after: string | undefined = undefined;
  while (true) {
    const res = await hsRetry(() =>
      hs.crm.deals.searchApi.doSearch({
        filterGroups: [{
          filters: [
            { propertyName: 'dealstage', operator: FilterOperatorEnum.Eq, value: CLOSED_WON_STAGE },
            { propertyName: 'closedate', operator: FilterOperatorEnum.Gte, value: String(windowStartMs) },
            { propertyName: 'closedate', operator: FilterOperatorEnum.Lte, value: String(windowEndMs) },
          ],
        }],
        properties: DEAL_PROPERTIES,
        limit: SEARCH_PAGE_SIZE,
        after: after ?? '',
      }),
    );
    for (const d of res.results) {
      rows.push({
        id: d.id,
        closedate: d.properties.closedate ?? null,
        dealname: d.properties.dealname ?? null,
        productType: d.properties.ss_product_type ?? null,
      });
    }
    const next = res.paging?.next?.after;
    if (next === undefined || next === '') break;
    after = next;
    await sleep(PACING_MS);
  }
  return rows;
};

const findCompanyIdForDeal = async (dealId: string): Promise<string | null> => {
  const detail = await hsRetry(() =>
    hs.crm.deals.basicApi.getById(dealId, DEAL_PROPERTIES, undefined, ['companies']),
  );
  return detail.associations?.companies?.results[0]?.id ?? null;
};

export const generateQuarterlyCheckins = async (): Promise<void> => {
  const now = Date.now();
  const cooldownCutoff = new Date(now - COOLDOWN_DAYS * MS_PER_DAY);

  // Three OR-equivalent passes (separate searches keep the AND-composed
  // dealstage + closedate filter unambiguous). Set dedups in the rare
  // overlap case if windows ever widen.
  const seen = new Set<string>();
  const candidates: DealRow[] = [];
  for (const [minDays, maxDays] of WINDOWS_DAYS) {
    const windowStartMs = now - maxDays * MS_PER_DAY;
    const windowEndMs = now - minDays * MS_PER_DAY;
    const deals = await fetchClosedWonDealsInWindow(windowStartMs, windowEndMs);
    for (const d of deals) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      candidates.push(d);
    }
  }

  let drafted = 0;
  let skipped = 0;
  for (const deal of candidates) {
    try {
      const companyId = await findCompanyIdForDeal(deal.id);
      if (companyId === null) {
        await audit('quarterlyCheckin.skip-no-company', deal.id, {});
        skipped += 1;
        continue;
      }

      const lead = await prisma.lead.findFirst({
        where: { hubspotCompanyId: companyId },
        include: { enrichment: true },
      });
      if (lead === null) {
        await audit('quarterlyCheckin.skip-no-lead', deal.id, { companyId });
        skipped += 1;
        continue;
      }
      const { enrichment, ...leadOnly } = lead;
      if (enrichment === null) {
        await audit('quarterlyCheckin.skip-no-enrichment', deal.id, { leadId: lead.id });
        skipped += 1;
        continue;
      }
      if (lead.doNotContact) {
        await audit('quarterlyCheckin.skip-do-not-contact', deal.id, { leadId: lead.id });
        skipped += 1;
        continue;
      }

      const recentDraft = await prisma.draft.findFirst({
        where: {
          leadId: lead.id,
          kind: 'quarterly',
          createdAt: { gte: cooldownCutoff },
        },
        select: { id: true },
      });
      if (recentDraft !== null) {
        await audit('quarterlyCheckin.skip-recent-draft', deal.id, {
          leadId: lead.id,
          existingDraftId: recentDraft.id,
        });
        skipped += 1;
        continue;
      }

      const closeDate = parseHsDate(deal.closedate);
      if (closeDate === null) {
        await audit('quarterlyCheckin.skip-no-closedate', deal.id, { leadId: lead.id });
        skipped += 1;
        continue;
      }
      const daysSinceClose = Math.round((now - closeDate.getTime()) / MS_PER_DAY);

      const userPrompt = buildQuarterlyUser(
        {
          name: deal.dealname ?? leadOnly.name,
          closeDate,
          productType: deal.productType,
        },
        leadOnly,
        enrichment,
        daysSinceClose,
      );

      const msg = await claude.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        system: cached(QUARTERLY_CHECKIN_SYSTEM),
        messages: [{ role: 'user', content: userPrompt }],
      });
      const gen = GenSchema.parse(extractJSON(msg));

      const draft = await prisma.draft.create({
        data: {
          leadId: lead.id,
          kind: 'quarterly',
          subject: gen.subject,
          body: gen.body,
          specificFacts: [],
          personalizationPct: null,
          status: 'pending',
        },
      });
      await audit('quarterlyCheckin.drafted', deal.id, {
        leadId: lead.id,
        draftId: draft.id,
        daysSinceClose,
      });
      drafted += 1;
    } catch (err) {
      await audit('quarterlyCheckin.failure', deal.id, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(PACING_MS);
  }

  await audit('quarterlyCheckin.run', null, {
    candidates: candidates.length,
    drafted,
    skipped,
  });
};
