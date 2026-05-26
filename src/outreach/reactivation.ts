// Reactivation drafter. Pulls open HubSpot deals (any non-closed stage)
// whose hs_lastmodifieddate is >30 days old, joins to the matching Lead
// via hubspotCompanyId, and drafts a reactivation email via Claude — but
// ONLY if the lead has prior engagement evidence in Draft history
// (kind='replied' or any followup-N) and we haven't already drafted a
// reactivation for that lead in the last 60 days.
//
// Lead lookup uses the hubspotCompanyId join (same pattern as
// outreach/quarterlyCheckin and outreach/renewalWarning): companies are
// upserted by domain in pipeline/hubspotSync, so Lead.hubspotCompanyId is
// the canonical domain-anchored FK — no redundant company GET needed.
//
// A weekly global cap of 10 keeps reactivation from flooding the queue
// when many deals go quiet at once. The cap is enforced against the
// rolling 7-day window of reactivation Drafts already in the table, so a
// mid-week run picks up exactly the remaining budget.
//
// Per-deal try/catch keeps a single bad lead from killing the run;
// failures surface via AuditLog so the cron entry's success row stays
// meaningful.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/deals/models/Filter.js';
import { z } from 'zod';
import { claude, extractJSON } from '../shared/claude.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import {
  REACTIVATION_SYSTEM,
  buildReactivationUser,
} from '../prompts/reactivation.js';

const cached = (text: string): Array<TextBlockParam> => [
  { type: 'text', text, cache_control: { type: 'ephemeral' } },
];

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 512;
const TEMPERATURE = 0.7;

const MS_PER_DAY = 86_400_000;
const STALE_DAYS = 30;
const COOLDOWN_DAYS = 60;
const WEEKLY_CAP = 10;
const WEEKLY_WINDOW_DAYS = 7;
const SEARCH_PAGE_SIZE = 100;
const PACING_MS = 100;
const DEAL_PROPERTIES = [
  'dealname',
  'dealstage',
  'hs_lastmodifieddate',
];
const CLOSED_STAGES = ['closedwon', 'closedlost'];
// Drafts that prove prior engagement: an inbound reply, or any of the
// outbound follow-up steps the sequencer creates (followup-2..followup-5).
// `startsWith: 'followup-'` keeps us aligned with sequencer.ts kinds even
// if MAX_STEP changes.
const REPLIED_KIND = 'replied';
const FOLLOWUP_KIND_PREFIX = 'followup-';
const REACTIVATION_KIND = 'reactivation';

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
// outreach/renewalWarning so callers never get a sentinel-value land mine.
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
  dealname: string | null;
  lastModified: string | null;
}

const fetchStaleOpenDeals = async (
  staleCutoffMs: number,
): Promise<DealRow[]> => {
  const rows: DealRow[] = [];
  let after: string | undefined = undefined;
  while (true) {
    const res = await hsRetry(() =>
      hs.crm.deals.searchApi.doSearch({
        filterGroups: [{
          filters: [
            { propertyName: 'dealstage', operator: FilterOperatorEnum.NotIn, values: CLOSED_STAGES },
            { propertyName: 'hs_lastmodifieddate', operator: FilterOperatorEnum.Lt, value: String(staleCutoffMs) },
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
        dealname: d.properties.dealname ?? null,
        lastModified: d.properties.hs_lastmodifieddate ?? null,
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

export const generateReactivationDrafts = async (): Promise<void> => {
  const now = Date.now();
  const staleCutoffMs = now - STALE_DAYS * MS_PER_DAY;
  const cooldownCutoff = new Date(now - COOLDOWN_DAYS * MS_PER_DAY);
  const weeklyWindowStart = new Date(now - WEEKLY_WINDOW_DAYS * MS_PER_DAY);

  const alreadyThisWeek = await prisma.draft.count({
    where: {
      kind: REACTIVATION_KIND,
      createdAt: { gte: weeklyWindowStart },
    },
  });
  const remainingBudget = WEEKLY_CAP - alreadyThisWeek;
  if (remainingBudget <= 0) {
    await audit('reactivation.skip-weekly-cap-reached', null, {
      alreadyThisWeek,
      weeklyCap: WEEKLY_CAP,
    });
    return;
  }

  const candidates = await fetchStaleOpenDeals(staleCutoffMs);

  let drafted = 0;
  let skipped = 0;
  let capHit = false;
  for (const deal of candidates) {
    if (drafted >= remainingBudget) {
      capHit = true;
      break;
    }
    try {
      const companyId = await findCompanyIdForDeal(deal.id);
      if (companyId === null) {
        await audit('reactivation.skip-no-company', deal.id, {});
        skipped += 1;
        continue;
      }

      const lead = await prisma.lead.findFirst({
        where: { hubspotCompanyId: companyId },
        include: { enrichment: true },
      });
      if (lead === null) {
        await audit('reactivation.skip-no-lead', deal.id, { companyId });
        skipped += 1;
        continue;
      }
      const { enrichment, ...leadOnly } = lead;
      if (enrichment === null) {
        await audit('reactivation.skip-no-enrichment', deal.id, { leadId: lead.id });
        skipped += 1;
        continue;
      }
      if (lead.doNotContact) {
        await audit('reactivation.skip-do-not-contact', deal.id, { leadId: lead.id });
        skipped += 1;
        continue;
      }

      // Prior engagement gate: lead must have at least one Draft showing
      // they replied or that we worked them through a follow-up. A fresh
      // cold lead with no history doesn't deserve a "reactivation" angle —
      // that's just another cold email.
      const engagementDraft = await prisma.draft.findFirst({
        where: {
          leadId: lead.id,
          OR: [
            { kind: REPLIED_KIND },
            { kind: { startsWith: FOLLOWUP_KIND_PREFIX } },
          ],
        },
        select: { id: true, kind: true },
      });
      if (engagementDraft === null) {
        await audit('reactivation.skip-no-engagement-history', deal.id, { leadId: lead.id });
        skipped += 1;
        continue;
      }

      const recentDraft = await prisma.draft.findFirst({
        where: {
          leadId: lead.id,
          kind: REACTIVATION_KIND,
          createdAt: { gte: cooldownCutoff },
        },
        select: { id: true },
      });
      if (recentDraft !== null) {
        await audit('reactivation.skip-recent-draft', deal.id, {
          leadId: lead.id,
          existingDraftId: recentDraft.id,
        });
        skipped += 1;
        continue;
      }

      const lastModified = parseHsDate(deal.lastModified);
      if (lastModified === null) {
        await audit('reactivation.skip-no-lastmodified', deal.id, { leadId: lead.id });
        skipped += 1;
        continue;
      }
      const daysSinceContact = Math.max(
        STALE_DAYS,
        Math.round((now - lastModified.getTime()) / MS_PER_DAY),
      );

      const userPrompt = buildReactivationUser(
        { name: deal.dealname ?? leadOnly.name },
        leadOnly,
        enrichment,
        daysSinceContact,
      );

      const msg = await claude.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        system: cached(REACTIVATION_SYSTEM),
        messages: [{ role: 'user', content: userPrompt }],
      });
      const gen = GenSchema.parse(extractJSON(msg));

      const draft = await prisma.draft.create({
        data: {
          leadId: lead.id,
          kind: REACTIVATION_KIND,
          subject: gen.subject,
          body: gen.body,
          specificFacts: [],
          personalizationPct: null,
          status: 'pending',
        },
      });
      await audit('reactivation.drafted', deal.id, {
        leadId: lead.id,
        draftId: draft.id,
        daysSinceContact,
        engagementDraftId: engagementDraft.id,
        engagementKind: engagementDraft.kind,
      });
      drafted += 1;
    } catch (err) {
      await audit('reactivation.failure', deal.id, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(PACING_MS);
  }

  await audit('reactivation.run', null, {
    candidates: candidates.length,
    drafted,
    skipped,
    alreadyThisWeek,
    weeklyCap: WEEKLY_CAP,
    capHit,
  });
};
