// Find or create a HubSpot deal for a Lead so prep briefs work before Sonia
// has manually staged a deal. Used by /prep-brief/lead/:leadId and the
// company lookup redirect — the brief itself is DB-first; this keeps CRM in sync.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { syncLeadToHubspot } from '../pipeline/hubspotSync.js';
import { hs, hsRetry } from './hubspot.js';

const TIER_DEAL_AMOUNT: Record<string, string> = {
  claimed: '600',
  select: '2400',
  premium: '9600',
};
const DEFAULT_TIER = 'claimed';
const DEFAULT_AMOUNT = '600';
const INITIAL_DEAL_STAGE = 'qualifiedtobuy';
const DEAL_PIPELINE = 'default';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const asString = (id: unknown): string => String(id);

export const findDealForCompany = async (companyId: string): Promise<string | null> => {
  try {
    const page = await hsRetry(() =>
      hs.crm.associations.v4.basicApi.getPage('companies', companyId, 'deals'),
    );
    const raw = page.results[0]?.toObjectId ?? null;
    return raw === null ? null : asString(raw);
  } catch {
    return null;
  }
};

export type EnsureDealResult = {
  dealId: string;
  companyId: string;
  created: boolean;
};

export const ensureDealForLead = async (leadId: string): Promise<EnsureDealResult> => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) throw new Error(`Lead not found: ${leadId}`);
  if (lead.enrichment === null) {
    throw new Error(`Lead ${leadId} has no enrichment — run pipeline/enrich first`);
  }

  let companyId = lead.hubspotCompanyId;
  if (companyId === null) {
    const synced = await syncLeadToHubspot(leadId);
    companyId = synced.companyId;
  }

  const existingDealId = await findDealForCompany(companyId);
  if (existingDealId !== null) {
    return { dealId: existingDealId, companyId, created: false };
  }

  const tier = lead.enrichment.expectedProduct ?? DEFAULT_TIER;
  const amount = TIER_DEAL_AMOUNT[tier] ?? DEFAULT_AMOUNT;
  const dealname = `${lead.name} — ${lead.city}, ${lead.state}`;

  const created = await hsRetry(() =>
    hs.crm.deals.basicApi.create({
      properties: {
        dealname,
        dealstage: INITIAL_DEAL_STAGE,
        pipeline: DEAL_PIPELINE,
        ss_product_type: tier,
        amount,
      },
    }),
  );

  await hsRetry(() =>
    hs.crm.associations.v4.basicApi.createDefault('deals', created.id, 'companies', companyId),
  );

  await prisma.auditLog.create({
    data: {
      action: 'prepBrief.dealCreated',
      entity: 'deal',
      entityId: created.id,
      meta: { leadId, companyId, tier, amount, dealname },
    },
  });

  return { dealId: created.id, companyId, created: true };
};
