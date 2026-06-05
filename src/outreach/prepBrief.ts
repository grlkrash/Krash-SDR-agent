// Discovery-call prep brief generator (Prompt 9.4).
//
// Primary entry: generatePrepBriefForLead(leadId) — uses our DB as source of
// truth and auto-creates a HubSpot deal when none exists. Legacy entry:
// generatePrepBriefWithLead(dealId) for direct deal URLs.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { Enrichment, Lead } from '@prisma/client';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { claude, extractText } from '../shared/claude.js';
import { ensureDealForLead } from '../shared/ensureHubspotDeal.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import {
  PREP_BRIEF_SYSTEM,
  buildPrepBriefUser,
  type PrepBriefContact,
  type PrepBriefDeal,
  type PrepBriefEngagement,
  type PrepBriefOutreachTouch,
} from '../prompts/prepBrief.js';

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 2000;
const TEMPERATURE = 0.4;
const ENGAGEMENT_LIMIT = 5;
const OUTREACH_HISTORY_LIMIT = 5;

const TIER_COMMISSIONS: Record<string, number> = {
  claimed: 60,
  select: 240,
  premium: 960,
};
const DEFAULT_COMMISSION = 240;

const DEAL_PROPERTIES = ['dealname', 'dealstage', 'amount', 'ss_product_type', 'closedate'];
const COMPANY_PROPERTIES = ['name', 'domain', 'ss_signals'];
const CONTACT_PROPERTIES = ['firstname', 'lastname', 'email', 'jobtitle'];

const ENGAGEMENT_KINDS = ['notes', 'emails', 'calls', 'meetings', 'tasks'] as const;
type EngagementType = (typeof ENGAGEMENT_KINDS)[number];
type EngagementKind = PrepBriefEngagement['kind'];

const KIND_FOR_TYPE: Record<EngagementType, EngagementKind> = {
  notes: 'note',
  emails: 'email',
  calls: 'call',
  meetings: 'meeting',
  tasks: 'task',
};

const PROPS_FOR_TYPE: Record<EngagementType, string[]> = {
  notes: ['hs_note_body', 'hs_timestamp', 'hs_createdate'],
  emails: ['hs_email_subject', 'hs_email_text', 'hs_email_direction', 'hs_timestamp', 'hs_createdate'],
  calls: ['hs_call_title', 'hs_call_body', 'hs_call_direction', 'hs_call_status', 'hs_timestamp', 'hs_createdate'],
  meetings: ['hs_meeting_title', 'hs_meeting_body', 'hs_meeting_outcome', 'hs_meeting_start_time', 'hs_timestamp', 'hs_createdate'],
  tasks: ['hs_task_subject', 'hs_task_body', 'hs_task_status', 'hs_timestamp', 'hs_createdate'],
};

const cached = (text: string): Array<TextBlockParam> => [
  { type: 'text', text, cache_control: { type: 'ephemeral' } },
];

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const asString = (id: unknown): string => String(id);

const parseTimestamp = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const num = Number(raw);
  if (!Number.isNaN(num) && num > 0) return num;
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso)) return iso;
  return null;
};

const normalizeEngagement = (
  kind: EngagementKind,
  properties: Record<string, string | null>,
): PrepBriefEngagement | null => {
  const tsMs = parseTimestamp(properties.hs_timestamp ?? properties.hs_createdate);
  if (tsMs === null) return null;
  let subject: string | null = null;
  let body: string | null = null;
  if (kind === 'note') {
    body = properties.hs_note_body ?? null;
  } else if (kind === 'email') {
    subject = properties.hs_email_subject ?? null;
    body = properties.hs_email_text ?? null;
  } else if (kind === 'call') {
    subject = properties.hs_call_title ?? null;
    body = properties.hs_call_body ?? null;
  } else if (kind === 'meeting') {
    subject = properties.hs_meeting_title ?? null;
    body = properties.hs_meeting_body ?? properties.hs_meeting_outcome ?? null;
  } else {
    subject = properties.hs_task_subject ?? null;
    body = properties.hs_task_body ?? null;
  }
  return { kind, subject, body, timestamp: new Date(tsMs).toISOString() };
};

const fetchEngagementsOfType = async (
  dealId: string,
  type: EngagementType,
): Promise<PrepBriefEngagement[]> => {
  let assoc;
  try {
    assoc = await hsRetry(() =>
      hs.crm.associations.v4.basicApi.getPage('deals', dealId, type),
    );
  } catch {
    return [];
  }
  const ids = assoc.results.map((r) => asString(r.toObjectId));
  if (ids.length === 0) return [];

  const kind = KIND_FOR_TYPE[type];
  const props = PROPS_FOR_TYPE[type];
  const out: PrepBriefEngagement[] = [];
  for (const id of ids) {
    try {
      const obj = await hsRetry(() =>
        hs.crm.objects.basicApi.getById(type, id, props),
      );
      const normalized = normalizeEngagement(kind, obj.properties);
      if (normalized !== null) out.push(normalized);
    } catch {
      // Per-engagement failures must not nuke the brief.
    }
  }
  return out;
};

const fetchEngagements = async (dealId: string): Promise<PrepBriefEngagement[]> => {
  const buckets = await Promise.all(
    ENGAGEMENT_KINDS.map((type) => fetchEngagementsOfType(dealId, type)),
  );
  const merged = buckets.flat();
  merged.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return merged.slice(0, ENGAGEMENT_LIMIT);
};

const fetchContacts = async (dealId: string): Promise<PrepBriefContact[]> => {
  let assoc;
  try {
    assoc = await hsRetry(() =>
      hs.crm.associations.v4.basicApi.getPage('deals', dealId, 'contacts'),
    );
  } catch {
    return [];
  }
  const ids = assoc.results.map((r) => asString(r.toObjectId));
  if (ids.length === 0) return [];
  const fetched = await Promise.all(
    ids.map(async (id) => {
      try {
        const c = await hsRetry(() =>
          hs.crm.contacts.basicApi.getById(id, CONTACT_PROPERTIES),
        );
        return c.properties;
      } catch {
        return null;
      }
    }),
  );
  return fetched
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p) => ({
      firstName: p.firstname ?? null,
      lastName: p.lastname ?? null,
      email: p.email ?? null,
      jobTitle: p.jobtitle ?? null,
    }));
};

const fetchOutreachHistory = async (leadId: string): Promise<PrepBriefOutreachTouch[]> => {
  const drafts = await prisma.draft.findMany({
    where: {
      leadId,
      kind: { not: 'prep-brief' },
      status: { in: ['sent', 'auto-sent'] },
      sentAt: { not: null },
    },
    orderBy: { sentAt: 'desc' },
    take: OUTREACH_HISTORY_LIMIT,
    select: { kind: true, subject: true, sentAt: true },
  });
  return drafts
    .filter((d): d is typeof d & { sentAt: Date } => d.sentAt !== null)
    .map((d) => ({
      kind: d.kind,
      subject: d.subject,
      sentAt: d.sentAt.toISOString(),
    }));
};

const emptyDealContext = (lead: Lead, enrichment: Enrichment): PrepBriefDeal => ({
  dealname: null,
  dealstage: null,
  amount: null,
  productType: enrichment.expectedProduct,
  closedate: null,
  companyName: lead.name,
  companyDomain: null,
  contacts: [],
});

const loadDealContext = async (dealId: string): Promise<{
  briefDeal: PrepBriefDeal;
  contacts: PrepBriefContact[];
  engagements: PrepBriefEngagement[];
}> => {
  const deal = await hsRetry(() =>
    hs.crm.deals.basicApi.getById(dealId, DEAL_PROPERTIES),
  );
  const dealProps = deal.properties;

  const companyAssoc = await hsRetry(() =>
    hs.crm.associations.v4.basicApi.getPage('deals', dealId, 'companies'),
  );
  const companyIdRaw = companyAssoc.results[0]?.toObjectId ?? null;
  let companyName: string | null = null;
  let companyDomain: string | null = null;
  if (companyIdRaw !== null) {
    const company = await hsRetry(() =>
      hs.crm.companies.basicApi.getById(asString(companyIdRaw), COMPANY_PROPERTIES),
    );
    companyName = company.properties.name ?? null;
    companyDomain = company.properties.domain ?? null;
  }

  const [contacts, engagements] = await Promise.all([
    fetchContacts(dealId),
    fetchEngagements(dealId),
  ]);

  const briefDeal: PrepBriefDeal = {
    dealname: dealProps.dealname ?? null,
    dealstage: dealProps.dealstage ?? null,
    amount: dealProps.amount ?? null,
    productType: dealProps.ss_product_type ?? null,
    closedate: dealProps.closedate ?? null,
    companyName,
    companyDomain,
    contacts,
  };

  return { briefDeal, contacts, engagements };
};

export type PrepBriefResult = {
  markdown: string;
  leadName: string;
  leadId: string;
  dealId: string | null;
};

const generateBriefCore = async (
  lead: Lead,
  enrichment: Enrichment,
  dealId: string | null,
): Promise<PrepBriefResult> => {
  const { briefDeal, contacts, engagements } = dealId === null
    ? { briefDeal: emptyDealContext(lead, enrichment), contacts: [], engagements: [] }
    : await loadDealContext(dealId);

  const tierKey = briefDeal.productType ?? enrichment.expectedProduct ?? '';
  const commission = TIER_COMMISSIONS[tierKey] ?? DEFAULT_COMMISSION;

  const coldSent = await prisma.draft.findFirst({
    where: {
      leadId: lead.id,
      kind: 'cold',
      status: { in: ['sent', 'auto-sent'] },
      sentAt: { not: null },
    },
    select: { id: true },
  });
  const freeListingOffered = coldSent !== null;
  const outreachHistory = await fetchOutreachHistory(lead.id);

  const userPrompt = buildPrepBriefUser(
    lead,
    enrichment,
    engagements,
    briefDeal,
    commission,
    freeListingOffered,
    outreachHistory,
  );

  const msg = await claude.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: cached(PREP_BRIEF_SYSTEM),
    messages: [{ role: 'user', content: userPrompt }],
  });
  const markdown = extractText(msg).trim();

  const now = new Date();
  await prisma.draft.create({
    data: {
      leadId: lead.id,
      kind: 'prep-brief',
      subject: `Prep brief: ${lead.name}`,
      body: markdown,
      specificFacts: [],
      status: 'sent',
      sentAt: now,
    },
  });

  await prisma.auditLog.create({
    data: {
      action: 'prepBrief.generated',
      entity: dealId === null ? 'lead' : 'deal',
      entityId: dealId ?? lead.id,
      meta: {
        leadId: lead.id,
        dealId,
        commission,
        tier: tierKey === '' ? null : tierKey,
        freeListingOffered,
        engagementCount: engagements.length,
        contactCount: contacts.length,
        outreachCount: outreachHistory.length,
      },
    },
  });

  return { markdown, leadName: lead.name, leadId: lead.id, dealId };
};

export const generatePrepBriefForLead = async (leadId: string): Promise<PrepBriefResult> => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) throw new Error(`Lead not found: ${leadId}`);
  const { enrichment, ...leadOnly } = lead;
  if (enrichment === null) {
    throw new Error(`Lead ${leadId} has no enrichment — run pipeline/enrich first`);
  }

  const { dealId } = await ensureDealForLead(leadId);
  return generateBriefCore(leadOnly, enrichment, dealId);
};

export const generatePrepBriefWithLead = async (dealId: string): Promise<PrepBriefResult> => {
  const companyAssoc = await hsRetry(() =>
    hs.crm.associations.v4.basicApi.getPage('deals', dealId, 'companies'),
  );
  const companyIdRaw = companyAssoc.results[0]?.toObjectId ?? null;
  if (companyIdRaw === null) {
    throw new Error(`Deal ${dealId} has no associated company`);
  }
  const companyId = asString(companyIdRaw);

  const lead = await prisma.lead.findFirst({
    where: { hubspotCompanyId: companyId },
    include: { enrichment: true },
  });
  if (lead === null) {
    throw new Error(`No Lead synced for company ${companyId} (deal ${dealId})`);
  }
  const { enrichment, ...leadOnly } = lead;
  if (enrichment === null) {
    throw new Error(`Lead ${lead.id} has no enrichment — run pipeline/enrich first`);
  }

  return generateBriefCore(leadOnly, enrichment, dealId);
};

export const generatePrepBrief = async (dealId: string): Promise<string> => {
  const { markdown } = await generatePrepBriefWithLead(dealId);
  return markdown;
};
