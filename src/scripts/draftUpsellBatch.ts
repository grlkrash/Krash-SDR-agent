// tsx src/scripts/draftUpsellBatch.ts
//
// Cron entry (8:00 AM ET): scan closed-won HubSpot deals, find the
// associated companies, match to Leads, and draft up to 5 upsell emails
// per run for customers whose enrichment.signals shows a NEW growth signal
// (hiring, missing competing-directory presence, or big-spender tech
// stack). Runs after enrichAll (5:30 AM) so the signals are fresh.
//
// Note on the HubSpot SDK shape: `searchApi.doSearch` does NOT accept an
// `associations` array — the PublicObjectSearchRequest type only carries
// filterGroups / properties / sorts / paging. Existing crons that need
// company associations (renewalWarning, quarterlyCheckin) resolve them via
// per-deal `basicApi.getById(dealId, props, undefined, ['companies'])`.
// We mirror that pattern here.

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/deals/models/Filter.js';
import { z } from 'zod';
import { hs, hsRetry } from '../shared/hubspot.js';
import { draftUpsell } from '../outreach/draftUpsell.js';

const MAX_DRAFTS_PER_RUN = 5;
const MAX_CANDIDATES = 200;
const SEARCH_PAGE_SIZE = 100;
const PACING_MS = 100;
const CLOSED_WON_STAGE = 'closedwon';
const DEAL_PROPERTIES = ['dealname', 'hubspot_owner_id'];
const BIG_SPENDER_FLOOR = 3;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Mirrors src/ui/queue.ts's SignalsSchema. Local-only — prompt and script
// modules don't import UI rendering code.
const SignalsSchema = z
  .object({
    competingDirectories: z
      .object({ missingFromAll: z.boolean().optional() })
      .partial()
      .optional(),
    hiring: z
      .object({
        active: z.boolean().optional(),
        roleTitles: z.array(z.string()).optional(),
      })
      .partial()
      .optional(),
    techStack: z
      .object({ bigSpenderScore: z.number().optional() })
      .partial()
      .optional(),
  })
  .partial();

const deriveSignalSummary = (
  signalsJson: Prisma.JsonValue,
  city: string,
): string | null => {
  const parsed = SignalsSchema.safeParse(signalsJson);
  if (!parsed.success) return null;
  const s = parsed.data;
  // Priority order matters: hiring beats missing-directories beats
  // big-spender, so the strongest "growth in motion" signal wins.
  if (s.hiring?.active === true) {
    const role = s.hiring.roleTitles?.[0] ?? 'staff';
    return `hiring ${role} in ${city}`;
  }
  if (s.competingDirectories?.missingFromAll === true) {
    return 'missing from competing directories';
  }
  const score = s.techStack?.bigSpenderScore ?? 0;
  if (score >= BIG_SPENDER_FLOOR) {
    return `high-spend tech stack (score ${score})`;
  }
  return null;
};

const fetchClosedWonCompanyIds = async (): Promise<Set<string>> => {
  const companyIds = new Set<string>();
  const dealIds: string[] = [];
  let after: string | undefined = undefined;
  while (dealIds.length < MAX_CANDIDATES) {
    const res = await hsRetry(() =>
      hs.crm.deals.searchApi.doSearch({
        filterGroups: [{
          filters: [
            { propertyName: 'dealstage', operator: FilterOperatorEnum.Eq, value: CLOSED_WON_STAGE },
          ],
        }],
        properties: DEAL_PROPERTIES,
        limit: SEARCH_PAGE_SIZE,
        after: after ?? '',
      }),
    );
    for (const d of res.results) {
      dealIds.push(d.id);
      if (dealIds.length >= MAX_CANDIDATES) break;
    }
    const next = res.paging?.next?.after;
    if (next === undefined || next === '') break;
    after = next;
    await sleep(PACING_MS);
  }

  for (const dealId of dealIds) {
    const detail = await hsRetry(() =>
      hs.crm.deals.basicApi.getById(dealId, DEAL_PROPERTIES, undefined, ['companies']),
    );
    for (const assoc of detail.associations?.companies?.results ?? []) {
      companyIds.add(assoc.id);
    }
    await sleep(PACING_MS);
  }
  return companyIds;
};

try {
  const companyIds = await fetchClosedWonCompanyIds();

  const leads = companyIds.size === 0
    ? []
    : await prisma.lead.findMany({
        where: { hubspotCompanyId: { in: [...companyIds] } },
        include: { enrichment: true },
      });

  let ok = 0;
  let skipped = 0;
  let fail = 0;
  for (const lead of leads) {
    if (ok >= MAX_DRAFTS_PER_RUN) break;
    if (lead.enrichment === null) {
      skipped += 1;
      continue;
    }
    const signalSummary = deriveSignalSummary(lead.enrichment.signals, lead.city);
    if (signalSummary === null) {
      skipped += 1;
      continue;
    }
    try {
      const draftId = await draftUpsell(lead.id, signalSummary);
      if (draftId === null) skipped += 1;
      else ok += 1;
    } catch (err) {
      fail += 1;
      await prisma.auditLog.create({ data: {
        action: 'draftUpsell.failure',
        entity: 'lead',
        entityId: lead.id,
        meta: { error: err instanceof Error ? err.message : String(err) },
      } });
    }
  }

  const summary = { candidates: leads.length, ok, skipped, fail };
  await prisma.auditLog.create({ data: {
    action: 'cron.success',
    entity: 'draftUpsellBatch',
    meta: summary,
  } });
  console.log(JSON.stringify(summary));
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  await prisma.auditLog.create({ data: {
    action: 'cron.failure',
    entity: 'draftUpsellBatch',
    meta: { error: message },
  } });
  throw err;
}
