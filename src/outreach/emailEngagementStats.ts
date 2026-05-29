// Email engagement stats for /queue dashboard — reply rate from Draft +
// AuditLog; open rate from HubSpot email engagements (hubspotEmailId) and
// contact hs_email_last_open_date as a fallback temperature signal.
//
// Gmail sends don't carry HubSpot tracking pixels, so open counts on logged
// CRM emails are often zero. Contact-level last-open still surfaces warm
// leads when HubSpot has seen any tracked open from that address.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/contacts/models/Filter.js';
import { z } from 'zod';
import { guessEmail } from '../shared/guessEmail.js';
import { hs, hsRetry } from '../shared/hubspot.js';

const SENT_STATUSES = ['sent', 'auto-sent'] as const;
const EXCLUDED_KINDS = ['voicemail', 'voicemail-2'] as const;
const OPEN_ATTRIBUTION_WINDOW_MS = 30 * 86_400_000;
const CACHE_TTL_MS = 5 * 60_000;
const HUBSPOT_CONTACT_BATCH = 50;
const HUBSPOT_EMAIL_BATCH = 25;
const HUBSPOT_PACE_MS = 80;

const ReplyAuditMetaSchema = z.object({
  matchedDraftId: z.string(),
  matchedDraftKind: z.string().optional(),
  leadId: z.string().optional(),
});

export type EngagementBucketId =
  | 'cold'
  | 'followup-2'
  | 'followup-3'
  | 'followup-4'
  | 'followup-5'
  | 'nudge'
  | 'reactivation'
  | 'renewal'
  | 'quarterly'
  | 'upsell'
  | 'replied'
  | 'other';

export type BucketStats = {
  bucket: EngagementBucketId;
  label: string;
  sent: number;
  opened: number;
  replied: number;
  openRate: number | null;
  replyRate: number | null;
};

export type EngagementOverview = {
  totals: { sent: number; opened: number; replied: number };
  openRate: number | null;
  replyRate: number | null;
  byBucket: BucketStats[];
  computedAt: string;
  openDataNote: string;
};

export type SentEmailRow = {
  draftId: string;
  kind: string;
  bucket: EngagementBucketId;
  bucketLabel: string;
  sentAt: string;
  opened: boolean;
  replied: boolean;
};

export type LeadEngagementSummary = {
  leadId: string;
  leadName: string;
  city: string;
  state: string;
  sent: number;
  opened: number;
  replied: number;
  temperature: 'hot' | 'warm' | 'cool' | 'cold';
  temperatureLabel: string;
  approachHint: string;
  emails: SentEmailRow[];
};

const BUCKET_LABELS: Record<EngagementBucketId, string> = {
  cold: 'Cold (touch 1)',
  'followup-2': 'Follow-up 1',
  'followup-3': 'Follow-up 2',
  'followup-4': 'Follow-up 3',
  'followup-5': 'Follow-up 4',
  nudge: 'Nudge',
  reactivation: 'Reactivation',
  renewal: 'Renewal',
  quarterly: 'Quarterly',
  upsell: 'Upsell',
  replied: 'Reply response',
  other: 'Other',
};

const BUCKET_ORDER: EngagementBucketId[] = [
  'cold',
  'followup-2',
  'followup-3',
  'followup-4',
  'followup-5',
  'nudge',
  'reactivation',
  'renewal',
  'quarterly',
  'upsell',
  'replied',
  'other',
];

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const bucketForKind = (kind: string): EngagementBucketId => {
  if (kind === 'cold') return 'cold';
  if (kind === 'followup-2') return 'followup-2';
  if (kind === 'followup-3') return 'followup-3';
  if (kind === 'followup-4') return 'followup-4';
  if (kind === 'followup-5') return 'followup-5';
  if (kind === 'nudge') return 'nudge';
  if (kind === 'reactivation') return 'reactivation';
  if (kind === 'renewal') return 'renewal';
  if (kind === 'quarterly') return 'quarterly';
  if (kind === 'upsell') return 'upsell';
  if (kind === 'replied') return 'replied';
  return 'other';
};

export const ratePct = (numerator: number, denominator: number): number | null => {
  if (denominator === 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
};

export const formatRate = (rate: number | null): string => {
  if (rate === null) return '—';
  return `${String(rate)}%`;
};

const parseHsDate = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso)) return iso;
  const num = Number(raw);
  if (!Number.isNaN(num) && num > 0) return num;
  return null;
};

type SentDraftRow = {
  id: string;
  kind: string;
  leadId: string;
  sentAt: Date;
  hubspotEmailId: string | null;
};

type ReplyEvent = {
  matchedDraftId: string;
  matchedDraftKind: string;
  leadId: string | null;
};

type LeadContact = {
  leadId: string;
  email: string;
};

type OpenSignals = {
  emailOpenCounts: Map<string, number>;
  contactLastOpenMs: Map<string, number>;
};

type EngagementData = {
  drafts: SentDraftRow[];
  replyEvents: ReplyEvent[];
  repliedDraftIds: Set<string>;
  leadEmails: Map<string, string>;
  signals: OpenSignals;
};

const loadEngagementData = async (): Promise<EngagementData> => {
  const [drafts, replyEvents] = await Promise.all([
    loadSentDrafts(),
    loadReplyEvents(),
  ]);
  const repliedDraftIds = new Set(replyEvents.map((e) => e.matchedDraftId));
  const leadIds = [...new Set(drafts.map((d) => d.leadId))];
  const leadContacts = await loadLeadContacts(leadIds);
  const leadEmails = leadEmailMap(leadContacts);
  const signals = await loadOpenSignals(drafts, leadContacts);
  return { drafts, replyEvents, repliedDraftIds, leadEmails, signals };
};

let cachedData: { payload: EngagementData; expiresAt: number } | null = null;

const getEngagementData = async (refresh?: boolean): Promise<EngagementData> => {
  const now = Date.now();
  if (refresh !== true && cachedData !== null && cachedData.expiresAt > now) {
    return cachedData.payload;
  }
  const payload = await loadEngagementData();
  cachedData = { payload, expiresAt: now + CACHE_TTL_MS };
  return payload;
};

const buildBadgesForLeads = (
  leadIds: string[],
  data: EngagementData,
): Map<string, LeadTemperatureBadge> => {
  const repliedByLead = new Map<string, number>();
  const sentByLead = new Map<string, number>();
  const openedByLead = new Map<string, number>();

  for (const draft of data.drafts) {
    if (!leadIds.includes(draft.leadId)) continue;
    sentByLead.set(draft.leadId, (sentByLead.get(draft.leadId) ?? 0) + 1);
    if (isDraftOpened(draft, data.leadEmails.get(draft.leadId), data.signals)) {
      openedByLead.set(draft.leadId, (openedByLead.get(draft.leadId) ?? 0) + 1);
    }
    if (data.repliedDraftIds.has(draft.id)) {
      repliedByLead.set(draft.leadId, (repliedByLead.get(draft.leadId) ?? 0) + 1);
    }
  }

  const badges = new Map<string, LeadTemperatureBadge>();
  for (const leadId of leadIds) {
    const sent = sentByLead.get(leadId) ?? 0;
    if (sent === 0) continue;
    const temp = computeTemperature(
      sent,
      openedByLead.get(leadId) ?? 0,
      repliedByLead.get(leadId) ?? 0,
    );
    badges.set(leadId, {
      temperature: temp.temperature,
      label: temp.label,
      href: `/queue/lead-engagement/${encodeURIComponent(leadId)}`,
    });
  }
  return badges;
};

const loadSentDrafts = async (): Promise<SentDraftRow[]> =>
  prisma.draft.findMany({
    where: {
      status: { in: [...SENT_STATUSES] },
      kind: { notIn: [...EXCLUDED_KINDS] },
      sentAt: { not: null },
    },
    select: {
      id: true,
      kind: true,
      leadId: true,
      sentAt: true,
      hubspotEmailId: true,
    },
    orderBy: { sentAt: 'desc' },
  }).then((rows) =>
    rows.flatMap((row) => {
      if (row.sentAt === null) return [];
      return [{
        id: row.id,
        kind: row.kind,
        leadId: row.leadId,
        sentAt: row.sentAt,
        hubspotEmailId: row.hubspotEmailId,
      }];
    }),
  );

const loadReplyEvents = async (): Promise<ReplyEvent[]> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'reply.draft-created' },
    select: { meta: true },
  });
  const events: ReplyEvent[] = [];
  for (const row of rows) {
    const parsed = ReplyAuditMetaSchema.safeParse(row.meta);
    if (!parsed.success) continue;
    events.push({
      matchedDraftId: parsed.data.matchedDraftId,
      matchedDraftKind: parsed.data.matchedDraftKind ?? 'other',
      leadId: parsed.data.leadId ?? null,
    });
  }
  return events;
};

const loadLeadContacts = async (leadIds: string[]): Promise<LeadContact[]> => {
  if (leadIds.length === 0) return [];
  const leads = await prisma.lead.findMany({
    where: { id: { in: leadIds } },
    include: { enrichment: true },
  });
  const contacts: LeadContact[] = [];
  for (const lead of leads) {
    const email =
      lead.enrichment?.ownerEmail?.trim()
      ?? guessEmail(lead.enrichment?.ownerName ?? null, lead.website);
    if (email === null || email === '') continue;
    contacts.push({ leadId: lead.id, email: email.toLowerCase() });
  }
  return contacts;
};

const fetchHubspotEmailOpenCounts = async (
  hubspotEmailIds: string[],
): Promise<Map<string, number>> => {
  const counts = new Map<string, number>();
  const unique = [...new Set(hubspotEmailIds.filter((id) => id !== ''))];
  for (let i = 0; i < unique.length; i += HUBSPOT_EMAIL_BATCH) {
    const batch = unique.slice(i, i + HUBSPOT_EMAIL_BATCH);
    for (const emailId of batch) {
      try {
        const row = await hsRetry(() =>
          hs.crm.objects.emails.basicApi.getById(emailId, [
            'hs_email_open_count',
          ]),
        );
        const raw = row.properties?.hs_email_open_count ?? '0';
        const openCount = Number(raw);
        counts.set(emailId, Number.isNaN(openCount) ? 0 : openCount);
      } catch {
        counts.set(emailId, 0);
      }
    }
    if (i + HUBSPOT_EMAIL_BATCH < unique.length) await sleep(HUBSPOT_PACE_MS);
  }
  return counts;
};

const fetchContactLastOpenByEmail = async (
  emails: string[],
): Promise<Map<string, number>> => {
  const lastOpen = new Map<string, number>();
  const unique = [...new Set(emails.map((e) => e.toLowerCase()))];
  for (let i = 0; i < unique.length; i += HUBSPOT_CONTACT_BATCH) {
    const batch = unique.slice(i, i + HUBSPOT_CONTACT_BATCH);
    try {
      const res = await hsRetry(() =>
        hs.crm.contacts.searchApi.doSearch({
          filterGroups: [{
            filters: [{
              propertyName: 'email',
              operator: FilterOperatorEnum.In,
              values: batch,
            }],
          }],
          properties: ['email', 'hs_email_last_open_date'],
          limit: HUBSPOT_CONTACT_BATCH,
        }),
      );
      for (const contact of res.results) {
        const email = contact.properties?.email?.toLowerCase() ?? '';
        if (email === '') continue;
        const openMs = parseHsDate(contact.properties?.hs_email_last_open_date);
        if (openMs !== null) lastOpen.set(email, openMs);
      }
    } catch {
      // HubSpot unavailable — open stats fall back to email-object counts only.
    }
    if (i + HUBSPOT_CONTACT_BATCH < unique.length) await sleep(HUBSPOT_PACE_MS);
  }
  return lastOpen;
};

const loadOpenSignals = async (
  drafts: SentDraftRow[],
  leadContacts: LeadContact[],
): Promise<OpenSignals> => {
  const hubspotEmailIds = drafts
    .map((d) => d.hubspotEmailId)
    .filter((id): id is string => id !== null);
  const emails = leadContacts.map((c) => c.email);
  const [emailOpenCounts, contactLastOpenMs] = await Promise.all([
    fetchHubspotEmailOpenCounts(hubspotEmailIds),
    fetchContactLastOpenByEmail(emails),
  ]);
  return { emailOpenCounts, contactLastOpenMs };
};

const leadEmailMap = (contacts: LeadContact[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const c of contacts) map.set(c.leadId, c.email);
  return map;
};

const isDraftOpened = (
  draft: SentDraftRow,
  leadEmail: string | undefined,
  signals: OpenSignals,
): boolean => {
  if (draft.hubspotEmailId !== null) {
    const count = signals.emailOpenCounts.get(draft.hubspotEmailId) ?? 0;
    if (count > 0) return true;
  }
  if (leadEmail === undefined) return false;
  const openMs = signals.contactLastOpenMs.get(leadEmail);
  if (openMs === undefined) return false;
  const sentMs = draft.sentAt.getTime();
  return openMs >= sentMs && openMs <= sentMs + OPEN_ATTRIBUTION_WINDOW_MS;
};

const buildBucketStats = (
  drafts: SentDraftRow[],
  repliedDraftIds: Set<string>,
  leadEmails: Map<string, string>,
  signals: OpenSignals,
): BucketStats[] => {
  const byBucket = new Map<EngagementBucketId, { sent: number; opened: number; replied: number }>();
  for (const id of BUCKET_ORDER) {
    byBucket.set(id, { sent: 0, opened: 0, replied: 0 });
  }

  for (const draft of drafts) {
    const bucket = bucketForKind(draft.kind);
    const row = byBucket.get(bucket) ?? { sent: 0, opened: 0, replied: 0 };
    row.sent += 1;
    if (isDraftOpened(draft, leadEmails.get(draft.leadId), signals)) row.opened += 1;
    if (repliedDraftIds.has(draft.id)) row.replied += 1;
    byBucket.set(bucket, row);
  }

  return BUCKET_ORDER
    .map((bucket) => {
      const row = byBucket.get(bucket) ?? { sent: 0, opened: 0, replied: 0 };
      return {
        bucket,
        label: BUCKET_LABELS[bucket],
        sent: row.sent,
        opened: row.opened,
        replied: row.replied,
        openRate: ratePct(row.opened, row.sent),
        replyRate: ratePct(row.replied, row.sent),
      };
    })
    .filter((row) => row.sent > 0);
};

const computeTemperature = (
  sent: number,
  opened: number,
  replied: number,
): { temperature: LeadEngagementSummary['temperature']; label: string; hint: string } => {
  if (replied > 0) {
    return {
      temperature: 'hot',
      label: 'Hot — replied',
      hint: 'They engaged. Prioritize a thoughtful reply or call; avoid generic follow-up templates.',
    };
  }
  if (opened > 0) {
    return {
      temperature: 'warm',
      label: 'Warm — opened',
      hint: 'Seen but silent. Try a shorter nudge with one clear ask, or a different angle on their pain point.',
    };
  }
  if (sent >= 3) {
    return {
      temperature: 'cold',
      label: 'Cold — no engagement',
      hint: 'Multiple sends with no signal. Consider pausing the sequence, trying a nudge, or a different channel.',
    };
  }
  return {
    temperature: 'cool',
    label: 'Cool — awaiting signal',
    hint: 'Too early to tell. Stay on sequence timing unless they go quiet past the awaiting-reply window.',
  };
};

const buildOverview = (
  drafts: SentDraftRow[],
  repliedDraftIds: Set<string>,
  leadEmails: Map<string, string>,
  signals: OpenSignals,
): EngagementOverview => {
  let opened = 0;
  let replied = 0;
  for (const draft of drafts) {
    if (isDraftOpened(draft, leadEmails.get(draft.leadId), signals)) opened += 1;
    if (repliedDraftIds.has(draft.id)) replied += 1;
  }
  const sent = drafts.length;
  const hasHubspotOpenData =
    signals.emailOpenCounts.size > 0 || signals.contactLastOpenMs.size > 0;
  const openDataNote = hasHubspotOpenData
    ? 'Open rate uses HubSpot email opens + contact last-open within 30 days of send. Gmail sends may under-report.'
    : 'Open rate unavailable — HubSpot did not return open data for tracked contacts.';

  return {
    totals: { sent, opened, replied },
    openRate: ratePct(opened, sent),
    replyRate: ratePct(replied, sent),
    byBucket: buildBucketStats(drafts, repliedDraftIds, leadEmails, signals),
    computedAt: new Date().toISOString(),
    openDataNote,
  };
};

export const getEngagementOverview = async (opts?: { refresh?: boolean }): Promise<EngagementOverview> => {
  const data = await getEngagementData(opts?.refresh === true);
  return buildOverview(data.drafts, data.repliedDraftIds, data.leadEmails, data.signals);
};

export const getEngagementDashboardBundle = async (
  leadIds: string[],
  opts?: { refresh?: boolean },
): Promise<{ overview: EngagementOverview; badges: Map<string, LeadTemperatureBadge> }> => {
  const data = await getEngagementData(opts?.refresh === true);
  return {
    overview: buildOverview(data.drafts, data.repliedDraftIds, data.leadEmails, data.signals),
    badges: buildBadgesForLeads(leadIds, data),
  };
};

export const getLeadEngagementSummary = async (
  leadId: string,
): Promise<LeadEngagementSummary | null> => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) return null;

  const data = await getEngagementData();
  const leadDrafts = data.drafts.filter((d) => d.leadId === leadId);
  const repliedDraftIds = new Set(
    data.replyEvents
      .filter((e) => e.leadId === leadId || leadDrafts.some((d) => d.id === e.matchedDraftId))
      .map((e) => e.matchedDraftId),
  );

  let opened = 0;
  let replied = 0;
  const emails: SentEmailRow[] = leadDrafts.map((draft) => {
    const wasOpened = isDraftOpened(draft, data.leadEmails.get(leadId), data.signals);
    const wasReplied = repliedDraftIds.has(draft.id);
    if (wasOpened) opened += 1;
    if (wasReplied) replied += 1;
    const bucket = bucketForKind(draft.kind);
    return {
      draftId: draft.id,
      kind: draft.kind,
      bucket,
      bucketLabel: BUCKET_LABELS[bucket],
      sentAt: draft.sentAt.toISOString(),
      opened: wasOpened,
      replied: wasReplied,
    };
  });

  const temp = computeTemperature(leadDrafts.length, opened, replied);

  return {
    leadId,
    leadName: lead.name,
    city: lead.city,
    state: lead.state,
    sent: leadDrafts.length,
    opened,
    replied,
    temperature: temp.temperature,
    temperatureLabel: temp.label,
    approachHint: temp.hint,
    emails,
  };
};

export type LeadTemperatureBadge = {
  temperature: LeadEngagementSummary['temperature'];
  label: string;
  href: string;
};

export const getLeadTemperatureBadges = async (
  leadIds: string[],
): Promise<Map<string, LeadTemperatureBadge>> => {
  if (leadIds.length === 0) return new Map();
  const data = await getEngagementData();
  return buildBadgesForLeads(leadIds, data);
};
