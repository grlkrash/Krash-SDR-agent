// Discovery-call prep brief generator (Prompt 9.4).
//
// Resolves a HubSpot deal → company → Lead/Enrichment, pulls the recent
// engagement history off the deal, and asks Claude to produce a 5-minute
// markdown brief. The result is persisted as a Draft (kind='prep-brief',
// status='sent') so /queue shows nothing — this is an internal artifact,
// not outbound mail. The audit row gives us a per-call observability hook
// (commission, tier, engagement count) without leaking the brief body.
//
// Engagement fetch:
//   The spec sketches `hs.crm.deals.associationsApi.getAll(dealId,
//   'engagements')`, but the v3 `associationsApi` was removed in
//   @hubspot/api-client v13.5.0 and there is no aggregate "engagements"
//   target in the v4 association graph. We replicate the legacy behavior
//   by querying each engagement type the portal exposes — notes, emails,
//   calls, meetings, tasks — and merging+sorting by hs_timestamp DESC.
//   Per-engagement failures are swallowed so one 404 doesn't kill the
//   brief; the audit row records the final count.
//
// Tier/commission lookup is the three listing tiers only. Upsell product
// types (seo/ppc/social/upsell-bundle) fall through to the 240 default,
// matching the spec literally.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { claude, extractText } from '../shared/claude.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import {
  PREP_BRIEF_SYSTEM,
  buildPrepBriefUser,
  type PrepBriefContact,
  type PrepBriefDeal,
  type PrepBriefEngagement,
} from '../prompts/prepBrief.js';

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 1500;
const TEMPERATURE = 0.4;

const ENGAGEMENT_LIMIT = 5;

// Three listing tiers only — upsell product types (seo/ppc/social/
// upsell-bundle) aren't tracked here and fall through to the 240 default,
// matching the spec lookup verbatim.
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

// Per-engagement-type property lists. Schemas differ enough that one
// shared list would 400 on most calls.
const PROPS_FOR_TYPE: Record<EngagementType, string[]> = {
  notes: ['hs_note_body', 'hs_timestamp', 'hs_createdate'],
  emails: [
    'hs_email_subject',
    'hs_email_text',
    'hs_email_direction',
    'hs_timestamp',
    'hs_createdate',
  ],
  calls: [
    'hs_call_title',
    'hs_call_body',
    'hs_call_direction',
    'hs_call_status',
    'hs_timestamp',
    'hs_createdate',
  ],
  meetings: [
    'hs_meeting_title',
    'hs_meeting_body',
    'hs_meeting_outcome',
    'hs_meeting_start_time',
    'hs_timestamp',
    'hs_createdate',
  ],
  tasks: [
    'hs_task_subject',
    'hs_task_body',
    'hs_task_status',
    'hs_timestamp',
    'hs_createdate',
  ],
};

const cached = (text: string): Array<TextBlockParam> => [
  { type: 'text', text, cache_control: { type: 'ephemeral' } },
];

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

// HubSpot v4 association responses declare `toObjectId` as `string` in the
// SDK type map, but the wire returns a JSON integer for numeric IDs. The
// downstream consumers (Prisma string filter, basicApi.getById's string
// arg) require an actual string, so coerce defensively at the boundary.
const asString = (id: unknown): string => String(id);

// HubSpot returns hs_timestamp as Unix-ms string on most engagement object
// types and hs_createdate as ISO. Mirrors parseHsDate from
// outreach/renewalWarning so we never feed an Invalid Date into Date.parse.
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
    // A 404 here means the portal has zero engagements of this type on the
    // deal — common for fresh deals. Treat as empty rather than fatal.
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
      // Per-engagement HubSpot 4xx/5xx must not nuke the brief.
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

export type PrepBriefResult = { markdown: string; leadName: string };

// Returns the markdown PLUS the lead's display name so the UI can populate
// the email subject / page title without a second HubSpot round trip. The
// spec-mandated `generatePrepBrief` wraps this for callers that only need
// the markdown.
export const generatePrepBriefWithLead = async (
  dealId: string,
): Promise<PrepBriefResult> => {
  const deal = await hsRetry(() =>
    hs.crm.deals.basicApi.getById(dealId, DEAL_PROPERTIES),
  );
  const dealProps = deal.properties;

  const companyAssoc = await hsRetry(() =>
    hs.crm.associations.v4.basicApi.getPage('deals', dealId, 'companies'),
  );
  const companyIdRaw = companyAssoc.results[0]?.toObjectId ?? null;
  if (companyIdRaw === null) {
    throw new Error(`Deal ${dealId} has no associated company`);
  }
  const companyId = asString(companyIdRaw);

  const company = await hsRetry(() =>
    hs.crm.companies.basicApi.getById(companyId, COMPANY_PROPERTIES),
  );

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

  // Contacts + engagements in parallel; both are independent of each other
  // and of the Lead/Enrichment Prisma lookup that already ran.
  const [contacts, engagements] = await Promise.all([
    fetchContacts(dealId),
    fetchEngagements(dealId),
  ]);

  const tierKey = dealProps.ss_product_type ?? enrichment.expectedProduct ?? '';
  const commission = TIER_COMMISSIONS[tierKey] ?? DEFAULT_COMMISSION;

  // Did this prospect enter through the free-listing cold angle? If a cold email
  // went out, the prep brief should frame the free→premium pivot and the
  // free-vs-paid objection.
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

  const briefDeal: PrepBriefDeal = {
    dealname: dealProps.dealname ?? null,
    dealstage: dealProps.dealstage ?? null,
    amount: dealProps.amount ?? null,
    productType: dealProps.ss_product_type ?? null,
    closedate: dealProps.closedate ?? null,
    companyName: company.properties.name ?? null,
    companyDomain: company.properties.domain ?? null,
    contacts,
  };

  const userPrompt = buildPrepBriefUser(
    leadOnly,
    enrichment,
    engagements,
    briefDeal,
    commission,
    freeListingOffered,
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
      entity: 'deal',
      entityId: dealId,
      meta: {
        leadId: lead.id,
        commission,
        tier: tierKey === '' ? null : tierKey,
        freeListingOffered,
        engagementCount: engagements.length,
        contactCount: contacts.length,
      },
    },
  });

  return { markdown, leadName: lead.name };
};

export const generatePrepBrief = async (dealId: string): Promise<string> => {
  const { markdown } = await generatePrepBriefWithLead(dealId);
  return markdown;
};
