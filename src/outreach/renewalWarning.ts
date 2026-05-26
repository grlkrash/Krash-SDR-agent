// Renewal warning generator. Pulls closed-won deals from HubSpot whose
// ss_renewal_date falls 55-65d out, finds the matching Lead, resolves the
// pricing tier from ss_product_type (falling back to
// enrichment.expectedProduct), and drafts a confident 60-day pre-renewal
// email via Claude.
//
// Lead lookup uses the hubspotCompanyId join (same pattern as
// outreach/quarterlyCheckin) since companies are upserted by domain in
// pipeline/hubspotSync — Lead.hubspotCompanyId is the canonical
// domain-anchored FK, so a redundant company GET is avoided.
//
// Tier resolution is strict: only the three listing tiers
// (claimed/select/premium) have prices in TIER_PRICES. Deals whose product
// type is an upsell (seo/social/ppc/upsell-bundle) are skipped and audited
// — those have separate pricing and aren't part of this drafter's scope.
//
// Per-deal try/catch keeps a single bad lead from killing the run; failures
// surface via AuditLog so the cron entry's success row stays meaningful.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/deals/models/Filter.js';
import { z } from 'zod';
import { claude, extractJSON } from '../shared/claude.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import {
  RENEWAL_WARNING_SYSTEM,
  buildRenewalUser,
} from '../prompts/renewalWarning.js';

const TIER_PRICES = { claimed: 600, select: 2400, premium: 9600 } as const;
type Tier = keyof typeof TIER_PRICES;

const cached = (text: string): Array<TextBlockParam> => [
  { type: 'text', text, cache_control: { type: 'ephemeral' } },
];

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 512;
const TEMPERATURE = 0.6;

const MS_PER_DAY = 86_400_000;
// 55-65d window so the daily cron has a 10-day catch radius around the
// nominal 60-day mark; combined with the 60-day per-lead cooldown, each
// renewing deal gets exactly one draft per renewal cycle.
const WINDOW_MIN_DAYS = 55;
const WINDOW_MAX_DAYS = 65;
const COOLDOWN_DAYS = 60;
const SEARCH_PAGE_SIZE = 100;
const PACING_MS = 100;
const DEAL_PROPERTIES = [
  'dealname',
  'dealstage',
  'ss_renewal_date',
  'ss_product_type',
];
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
// properties occasionally arrive as Unix-ms. Mirrors parseHsDate from
// outreach/quarterlyCheckin and pipeline/scoring so callers never get a
// sentinel-value land mine.
const parseHsDate = (raw: string | null | undefined): Date | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso)) return new Date(iso);
  const num = Number(raw);
  if (!Number.isNaN(num) && num > 0) return new Date(num);
  return null;
};

const isTier = (s: string | null | undefined): s is Tier =>
  s === 'claimed' || s === 'select' || s === 'premium';

interface DealRow {
  id: string;
  renewalDate: string | null;
  dealname: string | null;
  productType: string | null;
}

const fetchRenewingDealsInWindow = async (
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
            { propertyName: 'ss_renewal_date', operator: FilterOperatorEnum.Gte, value: String(windowStartMs) },
            { propertyName: 'ss_renewal_date', operator: FilterOperatorEnum.Lte, value: String(windowEndMs) },
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
        renewalDate: d.properties.ss_renewal_date ?? null,
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

export const generateRenewalWarnings = async (): Promise<void> => {
  const now = Date.now();
  const cooldownCutoff = new Date(now - COOLDOWN_DAYS * MS_PER_DAY);
  const windowStartMs = now + WINDOW_MIN_DAYS * MS_PER_DAY;
  const windowEndMs = now + WINDOW_MAX_DAYS * MS_PER_DAY;

  const candidates = await fetchRenewingDealsInWindow(windowStartMs, windowEndMs);

  let drafted = 0;
  let skipped = 0;
  for (const deal of candidates) {
    try {
      const companyId = await findCompanyIdForDeal(deal.id);
      if (companyId === null) {
        await audit('renewalWarning.skip-no-company', deal.id, {});
        skipped += 1;
        continue;
      }

      const lead = await prisma.lead.findFirst({
        where: { hubspotCompanyId: companyId },
        include: { enrichment: true },
      });
      if (lead === null) {
        await audit('renewalWarning.skip-no-lead', deal.id, { companyId });
        skipped += 1;
        continue;
      }
      const { enrichment, ...leadOnly } = lead;
      if (enrichment === null) {
        await audit('renewalWarning.skip-no-enrichment', deal.id, { leadId: lead.id });
        skipped += 1;
        continue;
      }
      if (lead.doNotContact) {
        await audit('renewalWarning.skip-do-not-contact', deal.id, { leadId: lead.id });
        skipped += 1;
        continue;
      }

      const recentDraft = await prisma.draft.findFirst({
        where: {
          leadId: lead.id,
          kind: 'renewal',
          createdAt: { gte: cooldownCutoff },
        },
        select: { id: true },
      });
      if (recentDraft !== null) {
        await audit('renewalWarning.skip-recent-draft', deal.id, {
          leadId: lead.id,
          existingDraftId: recentDraft.id,
        });
        skipped += 1;
        continue;
      }

      const renewalDate = parseHsDate(deal.renewalDate);
      if (renewalDate === null) {
        await audit('renewalWarning.skip-no-renewal-date', deal.id, { leadId: lead.id });
        skipped += 1;
        continue;
      }

      const tierCandidate = deal.productType ?? enrichment.expectedProduct ?? null;
      if (!isTier(tierCandidate)) {
        await audit('renewalWarning.skip-no-tier', deal.id, {
          leadId: lead.id,
          productType: deal.productType,
          expectedProduct: enrichment.expectedProduct,
        });
        skipped += 1;
        continue;
      }
      const tier: Tier = tierCandidate;
      const tierPrice = TIER_PRICES[tier];

      const userPrompt = buildRenewalUser(
        {
          name: deal.dealname ?? leadOnly.name,
          productType: deal.productType,
        },
        leadOnly,
        enrichment,
        renewalDate,
        tier,
        tierPrice,
      );

      const msg = await claude.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        system: cached(RENEWAL_WARNING_SYSTEM),
        messages: [{ role: 'user', content: userPrompt }],
      });
      const gen = GenSchema.parse(extractJSON(msg));

      const draft = await prisma.draft.create({
        data: {
          leadId: lead.id,
          kind: 'renewal',
          subject: gen.subject,
          body: gen.body,
          specificFacts: [],
          personalizationPct: null,
          status: 'pending',
        },
      });
      await audit('renewalWarning.drafted', deal.id, {
        leadId: lead.id,
        draftId: draft.id,
        tier,
        tierPrice,
        renewalDate: renewalDate.toISOString(),
      });
      drafted += 1;
    } catch (err) {
      await audit('renewalWarning.failure', deal.id, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(PACING_MS);
  }

  await audit('renewalWarning.run', null, {
    candidates: candidates.length,
    drafted,
    skipped,
  });
};
