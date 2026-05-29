// Email engagement stats for /queue dashboard — reply rate from Draft +
// AuditLog; open rate from first-party tracking pixels (AuditLog email.opened).

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const SENT_STATUSES = ['sent', 'auto-sent'] as const;
const EXCLUDED_KINDS = ['voicemail', 'voicemail-2'] as const;
const OPEN_AUDIT_ACTION = 'email.opened';
const CACHE_TTL_MS = 5 * 60_000;

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
  range: EngagementRange;
  rangeLabel: string;
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
  range: EngagementRange;
  rangeLabel: string;
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

const OPEN_DATA_NOTE =
  'Open rate uses a tracking pixel in auto-sent emails (sendApproved). '
  + 'Image-blocked clients won\'t register; Apple Mail Privacy Protection may inflate counts. '
  + 'Emails marked "Sent manually" from Gmail are not pixel-tracked.';

export type EngagementRange = '7d' | '30d' | '60d' | '90d' | 'all';

const MS_PER_DAY = 86_400_000;

const RANGE_DAYS: Record<Exclude<EngagementRange, 'all'>, number> = {
  '7d': 7,
  '30d': 30,
  '60d': 60,
  '90d': 90,
};

const RANGE_LABELS: Record<EngagementRange, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '60d': 'Last 60 days',
  '90d': 'Last 90 days',
  all: 'All time',
};

export const parseEngagementRange = (raw: unknown): EngagementRange => {
  if (raw === '7d' || raw === '30d' || raw === '60d' || raw === '90d' || raw === 'all') return raw;
  return 'all';
};

export const engagementRangeLabel = (range: EngagementRange): string => RANGE_LABELS[range];

export const draftSentWithinRange = (
  sentAt: Date,
  range: EngagementRange,
  nowMs: number = Date.now(),
): boolean => {
  if (range === 'all') return true;
  const cutoffMs = nowMs - RANGE_DAYS[range] * MS_PER_DAY;
  return sentAt.getTime() >= cutoffMs;
};

const filterDraftsForRange = (
  drafts: SentDraftRow[],
  range: EngagementRange,
): SentDraftRow[] =>
  drafts.filter((d) => draftSentWithinRange(d.sentAt, range));

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

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

type SentDraftRow = {
  id: string;
  kind: string;
  leadId: string;
  sentAt: Date;
};

type ReplyEvent = {
  matchedDraftId: string;
  matchedDraftKind: string;
  leadId: string | null;
};

type EngagementData = {
  drafts: SentDraftRow[];
  replyEvents: ReplyEvent[];
  repliedDraftIds: Set<string>;
  pixelOpenedDraftIds: Set<string>;
};

let cachedData: { payload: EngagementData; expiresAt: number } | null = null;

export const invalidateEngagementCache = (): void => {
  cachedData = null;
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

const loadPixelOpenedDraftIds = async (): Promise<Set<string>> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: OPEN_AUDIT_ACTION, entity: 'Draft' },
    select: { entityId: true },
  });
  const opened = new Set<string>();
  for (const row of rows) {
    if (row.entityId !== null && row.entityId !== '') opened.add(row.entityId);
  }
  return opened;
};

const isDraftOpened = (draft: SentDraftRow, pixelOpenedDraftIds: Set<string>): boolean =>
  pixelOpenedDraftIds.has(draft.id);

const loadEngagementData = async (): Promise<EngagementData> => {
  const [drafts, replyEvents, pixelOpenedDraftIds] = await Promise.all([
    loadSentDrafts(),
    loadReplyEvents(),
    loadPixelOpenedDraftIds(),
  ]);
  const repliedDraftIds = new Set(replyEvents.map((e) => e.matchedDraftId));
  return { drafts, replyEvents, repliedDraftIds, pixelOpenedDraftIds };
};

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
  range: EngagementRange,
): Map<string, LeadTemperatureBadge> => {
  const drafts = filterDraftsForRange(data.drafts, range);
  const repliedByLead = new Map<string, number>();
  const sentByLead = new Map<string, number>();
  const openedByLead = new Map<string, number>();

  for (const draft of drafts) {
    if (!leadIds.includes(draft.leadId)) continue;
    sentByLead.set(draft.leadId, (sentByLead.get(draft.leadId) ?? 0) + 1);
    if (isDraftOpened(draft, data.pixelOpenedDraftIds)) {
      openedByLead.set(draft.leadId, (openedByLead.get(draft.leadId) ?? 0) + 1);
    }
    if (data.repliedDraftIds.has(draft.id)) {
      repliedByLead.set(draft.leadId, (repliedByLead.get(draft.leadId) ?? 0) + 1);
    }
  }

  const periodQs = range === 'all' ? '' : `?period=${encodeURIComponent(range)}`;
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
      href: `/queue/lead-engagement/${encodeURIComponent(leadId)}${periodQs}`,
    });
  }
  return badges;
};

const buildBucketStats = (
  drafts: SentDraftRow[],
  repliedDraftIds: Set<string>,
  pixelOpenedDraftIds: Set<string>,
): BucketStats[] => {
  const byBucket = new Map<EngagementBucketId, { sent: number; opened: number; replied: number }>();
  for (const id of BUCKET_ORDER) {
    byBucket.set(id, { sent: 0, opened: 0, replied: 0 });
  }

  for (const draft of drafts) {
    const bucket = bucketForKind(draft.kind);
    const row = byBucket.get(bucket) ?? { sent: 0, opened: 0, replied: 0 };
    row.sent += 1;
    if (isDraftOpened(draft, pixelOpenedDraftIds)) row.opened += 1;
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
  pixelOpenedDraftIds: Set<string>,
  range: EngagementRange,
): EngagementOverview => {
  const scoped = filterDraftsForRange(drafts, range);
  let opened = 0;
  let replied = 0;
  for (const draft of scoped) {
    if (isDraftOpened(draft, pixelOpenedDraftIds)) opened += 1;
    if (repliedDraftIds.has(draft.id)) replied += 1;
  }
  const sent = scoped.length;

  return {
    totals: { sent, opened, replied },
    openRate: ratePct(opened, sent),
    replyRate: ratePct(replied, sent),
    byBucket: buildBucketStats(scoped, repliedDraftIds, pixelOpenedDraftIds),
    computedAt: new Date().toISOString(),
    openDataNote: OPEN_DATA_NOTE,
    range,
    rangeLabel: engagementRangeLabel(range),
  };
};

export const getEngagementOverview = async (opts?: {
  refresh?: boolean;
  range?: EngagementRange;
}): Promise<EngagementOverview> => {
  const range = opts?.range ?? 'all';
  const data = await getEngagementData(opts?.refresh === true);
  return buildOverview(data.drafts, data.repliedDraftIds, data.pixelOpenedDraftIds, range);
};

export const getEngagementDashboardBundle = async (
  leadIds: string[],
  opts?: { refresh?: boolean; range?: EngagementRange },
): Promise<{ overview: EngagementOverview; badges: Map<string, LeadTemperatureBadge> }> => {
  const range = opts?.range ?? 'all';
  const data = await getEngagementData(opts?.refresh === true);
  return {
    overview: buildOverview(data.drafts, data.repliedDraftIds, data.pixelOpenedDraftIds, range),
    badges: buildBadgesForLeads(leadIds, data, range),
  };
};

export const getLeadEngagementSummary = async (
  leadId: string,
  opts?: { range?: EngagementRange },
): Promise<LeadEngagementSummary | null> => {
  const range = opts?.range ?? 'all';
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) return null;

  const data = await getEngagementData();
  const leadDrafts = filterDraftsForRange(
    data.drafts.filter((d) => d.leadId === leadId),
    range,
  );
  const repliedDraftIds = new Set(
    data.replyEvents
      .filter((e) => e.leadId === leadId || leadDrafts.some((d) => d.id === e.matchedDraftId))
      .map((e) => e.matchedDraftId),
  );

  let opened = 0;
  let replied = 0;
  const emails: SentEmailRow[] = leadDrafts.map((draft) => {
    const wasOpened = isDraftOpened(draft, data.pixelOpenedDraftIds);
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
    range,
    rangeLabel: engagementRangeLabel(range),
  };
};

export type LeadTemperatureBadge = {
  temperature: LeadEngagementSummary['temperature'];
  label: string;
  href: string;
};

export const getLeadTemperatureBadges = async (
  leadIds: string[],
  opts?: { range?: EngagementRange },
): Promise<Map<string, LeadTemperatureBadge>> => {
  if (leadIds.length === 0) return new Map();
  const range = opts?.range ?? 'all';
  const data = await getEngagementData();
  return buildBadgesForLeads(leadIds, data, range);
};
