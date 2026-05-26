// Weekly intent-signal refresh (PRD §9.12).
//
// For the top open deals (by latest Score × commission), re-fetch Google
// Places ratings on matching gmaps leads and re-run the Serper hiring query.
// When hiring.active flips false → true, audit intent.hiring-spike so the
// daily brief can surface a 🚨 Hiring spike row the next day.

import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { hs, hsRetry } from '../shared/hubspot.js';
import { detectHiring, type Signals } from './signals.js';
import { fetchPlaceRatings } from './sources/places.js';

const MAX_DEALS = 100;
const SCORE_LOOKBACK_DAYS = 7;
const PACING_MS = 100;
const CLOSED_STAGES = ['closedwon', 'closedlost'];
const DEAL_PROPERTIES = ['dealname'];

const SignalsSchema = z.object({
  hiring: z
    .object({
      active: z.boolean().optional(),
      roleTitles: z.array(z.string()).optional(),
      rolesPostedRecently: z.number().optional(),
    })
    .partial()
    .optional(),
}).passthrough();

const PlaceMetaSchema = z.object({ id: z.string().optional() }).passthrough();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export type RefreshIntentSummary = {
  dealsConsidered: number;
  leadsProcessed: number;
  placesRefreshed: number;
  hiringSpikes: number;
  skipped: number;
  fail: number;
};

const dedupeLatestScores = (
  rows: Array<{
    hubspotDealId: string;
    score: number;
    expectedCommission: number;
    scoredAt: Date;
  }>,
): Map<string, { hubspotDealId: string; score: number; expectedCommission: number }> => {
  const byDeal = new Map<string, { hubspotDealId: string; score: number; expectedCommission: number; scoredAt: Date }>();
  for (const row of rows) {
    const prev = byDeal.get(row.hubspotDealId);
    if (prev === undefined || row.scoredAt > prev.scoredAt) {
      byDeal.set(row.hubspotDealId, row);
    }
  }
  const out = new Map<string, { hubspotDealId: string; score: number; expectedCommission: number }>();
  for (const row of byDeal.values()) {
    out.set(row.hubspotDealId, {
      hubspotDealId: row.hubspotDealId,
      score: row.score,
      expectedCommission: row.expectedCommission,
    });
  }
  return out;
};

const topOpenDealIds = async (prisma: PrismaClient): Promise<Array<string>> => {
  const cutoff = new Date(Date.now() - SCORE_LOOKBACK_DAYS * 86_400_000);
  const rows = await prisma.score.findMany({
    where: { scoredAt: { gte: cutoff } },
    orderBy: { scoredAt: 'desc' },
    select: {
      hubspotDealId: true,
      score: true,
      expectedCommission: true,
      scoredAt: true,
    },
  });
  const latest = dedupeLatestScores(rows);
  return [...latest.values()]
    .sort((a, b) => b.score * b.expectedCommission - a.score * b.expectedCommission)
    .slice(0, MAX_DEALS)
    .map((r) => r.hubspotDealId);
};

const isDealStillOpen = async (dealId: string): Promise<boolean> => {
  const deal = await hsRetry(() =>
    hs.crm.deals.basicApi.getById(dealId, ['dealstage']),
  );
  const stage = deal.properties.dealstage ?? '';
  return stage !== '' && !CLOSED_STAGES.includes(stage);
};

const extractPlaceId = (source: string, sourceMeta: Prisma.JsonValue): string | null => {
  if (source !== 'gmaps') return null;
  const parsed = PlaceMetaSchema.safeParse(sourceMeta);
  const id = parsed.success ? parsed.data.id : undefined;
  return id !== undefined && id !== '' ? id : null;
};

const mergeHiringIntoSignals = (
  existing: Prisma.JsonValue,
  hiring: Signals['hiring'],
): Prisma.InputJsonValue => {
  const base = SignalsSchema.safeParse(existing);
  const merged = base.success ? { ...base.data, hiring } : { hiring };
  return merged as Prisma.InputJsonValue;
};

export const refreshIntentSignals = async (prisma: PrismaClient): Promise<RefreshIntentSummary> => {
  const dealIds = await topOpenDealIds(prisma);
  let leadsProcessed = 0;
  let placesRefreshed = 0;
  let hiringSpikes = 0;
  let skipped = 0;
  let fail = 0;

  for (const dealId of dealIds) {
    try {
      if (!(await isDealStillOpen(dealId))) {
        skipped += 1;
        continue;
      }

      const detail = await hsRetry(() =>
        hs.crm.deals.basicApi.getById(dealId, DEAL_PROPERTIES, undefined, ['companies']),
      );
      const companyId = detail.associations?.companies?.results?.[0]?.id ?? null;
      if (companyId === null) {
        skipped += 1;
        continue;
      }

      const lead = await prisma.lead.findFirst({
        where: { hubspotCompanyId: companyId },
        include: { enrichment: true },
      });
      if (lead === null || lead.enrichment === null) {
        skipped += 1;
        continue;
      }

      leadsProcessed += 1;
      const enrichment = lead.enrichment;

      const parsedSignals = SignalsSchema.safeParse(enrichment.signals);
      const wasActive = parsedSignals.success ? parsedSignals.data.hiring?.active === true : false;
      const newHiring = await detectHiring({ name: lead.name });

      if (!wasActive && newHiring.active) {
        hiringSpikes += 1;
        await prisma.auditLog.create({
          data: {
            action: 'intent.hiring-spike',
            entity: 'deal',
            entityId: dealId,
            meta: {
              leadId: lead.id,
              facility: lead.name,
              city: lead.city,
              state: lead.state,
              roleTitles: newHiring.roleTitles,
            },
          },
        });
      }

      await prisma.enrichment.update({
        where: { id: enrichment.id },
        data: { signals: mergeHiringIntoSignals(enrichment.signals, newHiring) },
      });

      const placeId = extractPlaceId(lead.source, lead.sourceMeta);
      if (placeId !== null) {
        const { rating, reviewCount } = await fetchPlaceRatings(placeId);
        await prisma.lead.update({
          where: { id: lead.id },
          data: { googleRating: rating, googleReviews: reviewCount },
        });
        placesRefreshed += 1;
      }

      await sleep(PACING_MS);
    } catch (err) {
      fail += 1;
      await prisma.auditLog.create({
        data: {
          action: 'refreshIntent.failure',
          entity: 'deal',
          entityId: dealId,
          meta: { error: err instanceof Error ? err.message : String(err) },
        },
      });
    }
  }

  return {
    dealsConsidered: dealIds.length,
    leadsProcessed,
    placesRefreshed,
    hiringSpikes,
    skipped,
    fail,
  };
};
