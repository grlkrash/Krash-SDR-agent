import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Enrichment, type Lead } from '@prisma/client';
import { hs, hsRetry } from '../../shared/hubspot.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const DEAL_PROPERTIES = ['dealname', 'amount', 'hs_lastmodifieddate'];

export interface ScoreFacts {
  hubspotDealId: string;
  score: number;
  expectedCommission: number;
  reasons: string[];
  scoredAt: Date;
}

export interface EnrichedDeal {
  dealId: string;
  dealName: string;
  lead: (Lead & { enrichment: Enrichment | null }) | null;
}

export const dedupeLatestScores = (
  rows: Array<{
    hubspotDealId: string;
    score: number;
    expectedCommission: number;
    reasons: string[];
    scoredAt: Date;
  }>,
): ScoreFacts[] => {
  const latest = new Map<string, ScoreFacts>();
  for (const r of rows) {
    if (latest.has(r.hubspotDealId)) continue;
    latest.set(r.hubspotDealId, {
      hubspotDealId: r.hubspotDealId,
      score: r.score,
      expectedCommission: r.expectedCommission,
      reasons: r.reasons,
      scoredAt: r.scoredAt,
    });
  }
  return [...latest.values()];
};

export const enrichDeals = async (dealIds: string[]): Promise<Map<string, EnrichedDeal>> => {
  const out = new Map<string, EnrichedDeal>();
  if (dealIds.length === 0) return out;

  const results = await Promise.all(
    dealIds.map(async (id) => {
      try {
        const deal = await hsRetry(() =>
          hs.crm.deals.basicApi.getById(id, DEAL_PROPERTIES, undefined, ['companies']),
        );
        const companyId = deal.associations?.companies?.results[0]?.id ?? null;
        return { id, dealName: deal.properties.dealname ?? null, companyId };
      } catch {
        return { id, dealName: null, companyId: null };
      }
    }),
  );

  const companyIds = new Set<string>();
  for (const r of results) {
    if (r.companyId !== null) companyIds.add(r.companyId);
  }

  const leadByCompany = new Map<string, Lead & { enrichment: Enrichment | null }>();
  if (companyIds.size > 0) {
    const leads = await prisma.lead.findMany({
      where: { hubspotCompanyId: { in: [...companyIds] } },
      include: { enrichment: true },
    });
    for (const l of leads) {
      if (l.hubspotCompanyId !== null) leadByCompany.set(l.hubspotCompanyId, l);
    }
  }

  for (const r of results) {
    const lead = r.companyId === null ? null : (leadByCompany.get(r.companyId) ?? null);
    out.set(r.id, {
      dealId: r.id,
      dealName: r.dealName ?? '(unnamed deal)',
      lead,
    });
  }
  return out;
};
