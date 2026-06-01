// Attributes booked HubSpot meetings back to the email/sequence that sourced
// them, so the engagement dashboard can report a booking rate per step — the
// metric that actually pays. Their best sequence books at ~7x its reply rate
// (people book straight off the calendar link without replying), which reply-
// and open-tracking alone can't see.
//
// Mechanism: for each recently-created meeting, map its associated company →
// Lead, find the most recent outbound draft sent before the meeting was booked,
// and write an idempotent `meeting.booked` AuditLog row. emailEngagementStats
// reads those rows (DB-only, same pattern as reply.draft-created / email.opened)
// and credits the sourcing draft's bucket.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/objects/meetings/models/Filter.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import { bucketForKind } from './emailEngagementStats.js';

const MS_PER_DAY = 86_400_000;
const MEETING_LOOKBACK_DAYS = 30;
const SOURCING_WINDOW_DAYS = 90;
const SEARCH_PAGE_SIZE = 100;
const PACING_MS = 80;
const MEETING_PROPERTIES = ['hs_createdate', 'hs_meeting_start_time', 'hs_meeting_title'];
const ATTRIBUTABLE_KINDS = [
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
];
const SENT_STATUSES = ['sent', 'auto-sent'];

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const audit = (
  action: string,
  entityId: string,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'meeting', entityId, meta } });

// HubSpot returns hs_createdate as ISO and system timestamps occasionally as
// Unix-ms. Mirrors parseHsDate elsewhere so a bad value never becomes NaN.
const parseHsMs = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso)) return iso;
  const num = Number(raw);
  if (!Number.isNaN(num) && num > 0) return num;
  return null;
};

const fetchRecentMeetingIds = async (sinceMs: number): Promise<string[]> => {
  const ids: string[] = [];
  let after: string | undefined = undefined;
  while (true) {
    const res = await hsRetry(() =>
      hs.crm.objects.meetings.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'hs_createdate',
            operator: FilterOperatorEnum.Gte,
            value: String(sinceMs),
          }],
        }],
        properties: ['hs_createdate'],
        limit: SEARCH_PAGE_SIZE,
        after: after ?? '',
      }),
    );
    for (const m of res.results) ids.push(m.id);
    const next = res.paging?.next?.after;
    if (next === undefined || next === '') break;
    after = next;
    await sleep(PACING_MS);
  }
  return ids;
};

export type AttributionResult = { meetings: number; attributed: number; skipped: number };

export const attributeRecentMeetings = async (): Promise<AttributionResult> => {
  const now = Date.now();
  const sinceMs = now - MEETING_LOOKBACK_DAYS * MS_PER_DAY;
  const meetingIds = await fetchRecentMeetingIds(sinceMs);

  let attributed = 0;
  let skipped = 0;

  for (const meetingId of meetingIds) {
    try {
      const existing = await prisma.auditLog.findFirst({
        where: { action: 'meeting.booked', entityId: meetingId },
        select: { id: true },
      });
      if (existing !== null) {
        skipped += 1;
        continue;
      }

      const meeting = await hsRetry(() =>
        hs.crm.objects.meetings.basicApi.getById(
          meetingId,
          MEETING_PROPERTIES,
          undefined,
          ['companies'],
        ),
      );
      const createdAtMs = parseHsMs(meeting.properties?.hs_createdate) ?? now;
      const startAtMs = parseHsMs(meeting.properties?.hs_meeting_start_time);
      const companyId = meeting.associations?.companies?.results[0]?.id ?? null;
      if (companyId === null) {
        await audit('meeting.unattributed', meetingId, { reason: 'no-company' });
        skipped += 1;
        await sleep(PACING_MS);
        continue;
      }

      const lead = await prisma.lead.findFirst({
        where: { hubspotCompanyId: companyId },
        select: { id: true },
      });
      if (lead === null) {
        await audit('meeting.unattributed', meetingId, { reason: 'no-lead', companyId });
        skipped += 1;
        await sleep(PACING_MS);
        continue;
      }

      const windowStart = new Date(createdAtMs - SOURCING_WINDOW_DAYS * MS_PER_DAY);
      const sourcing = await prisma.draft.findFirst({
        where: {
          leadId: lead.id,
          kind: { in: ATTRIBUTABLE_KINDS },
          status: { in: SENT_STATUSES },
          sentAt: { gte: windowStart, lte: new Date(createdAtMs) },
        },
        orderBy: { sentAt: 'desc' },
        select: { id: true, kind: true },
      });

      await audit('meeting.booked', meetingId, {
        leadId: lead.id,
        companyId,
        draftId: sourcing?.id ?? null,
        draftKind: sourcing?.kind ?? null,
        bucket: sourcing === null ? null : bucketForKind(sourcing.kind),
        bookedAt: new Date(createdAtMs).toISOString(),
        startAt: startAtMs === null ? null : new Date(startAtMs).toISOString(),
      });
      attributed += 1;
      await sleep(PACING_MS);
    } catch (err) {
      await audit('meeting.attribution-failed', meetingId, {
        error: err instanceof Error ? err.message : String(err),
      });
      skipped += 1;
    }
  }

  return { meetings: meetingIds.length, attributed, skipped };
};
