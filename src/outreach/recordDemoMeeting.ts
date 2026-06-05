// Shared HubSpot + sequence bookkeeping when a demo is booked (auto or manual).

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { hs, hsRetry } from '../shared/hubspot.js';
import { ensureDealForLead } from '../shared/ensureHubspotDeal.js';
import { findContactIdByEmail } from '../shared/hubspotLinks.js';
import { updateDealStage } from '../shared/hubspotDealStages.js';
import { logHubspotNote } from '../shared/logHubspotNote.js';
import { wallEtToUtcDate } from '../shared/parseDemoDatetime.js';
import { bucketForKind } from './emailEngagementStats.js';
import { getOutboundSequenceState, logOutboundTouch } from './outboundSequence.js';

const DEFAULT_DURATION_MIN = 30;
const SOURCING_WINDOW_DAYS = 90;
const MS_PER_DAY = 86_400_000;
const SENT_STATUSES = ['sent', 'auto-sent'];
const ATTRIBUTABLE_KINDS = ['cold', 'followup-2', 'followup-3', 'followup-4', 'followup-5', 'nudge'];
const HUBSPOT_MEETING_OUTCOME = 'SCHEDULED';
const DEMO_DEAL_STAGE = 'appointmentscheduled';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const audit = (
  action: string,
  entityId: string,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'meeting', entityId, meta } });

export type RecordDemoResult = {
  meetingId: string;
  dealId: string;
  attendeeEmail: string;
  startAtIso: string;
};

export const recordDemoMeeting = async (opts: {
  leadId: string;
  startAtLocal: string;
  durationMinutes?: number;
  attendeeEmail: string;
  notes?: string;
  source: 'outbound-ui-auto' | 'outbound-ui-manual';
  meetUrl?: string | null;
  calendarEventId?: string | null;
  startAtOverride?: Date;
}): Promise<RecordDemoResult> => {
  const attendeeEmail = opts.attendeeEmail.trim().toLowerCase();
  if (attendeeEmail === '') throw new Error('Client email is required');

  const lead = await prisma.lead.findUnique({
    where: { id: opts.leadId },
    include: { enrichment: true },
  });
  if (lead === null) throw new Error('Lead not found');
  if (lead.enrichment === null) throw new Error('Lead has no enrichment');

  const { dealId, companyId } = await ensureDealForLead(opts.leadId);
  const durationMinutes = opts.durationMinutes ?? DEFAULT_DURATION_MIN;
  const title = `Sobriety Select discovery — ${lead.name}`;
  const notes = opts.notes?.trim() ?? '';
  const bodyParts = [
    `Discovery demo with ${lead.name} (${lead.city}, ${lead.state}).`,
    opts.source === 'outbound-ui-manual'
      ? 'Calendar invite sent manually from Google Calendar.'
      : '',
    notes !== '' ? `Notes: ${notes}` : '',
  ].filter((p) => p !== '');
  const meetingBody = bodyParts.join('\n\n');

  const startAtDate = opts.startAtOverride ?? wallEtToUtcDate(opts.startAtLocal);
  const endAtDate = new Date(startAtDate.getTime() + durationMinutes * 60_000);
  const meetUrl = opts.meetUrl ?? null;

  const meeting = await hsRetry(() =>
    hs.crm.objects.meetings.basicApi.create({
      properties: {
        hs_timestamp: startAtDate.getTime().toString(),
        hs_meeting_start_time: startAtDate.toISOString(),
        hs_meeting_end_time: endAtDate.toISOString(),
        hs_meeting_title: title,
        hs_meeting_body: meetingBody,
        hs_meeting_outcome: HUBSPOT_MEETING_OUTCOME,
        hs_meeting_location: meetUrl ?? 'Google Meet',
        hs_meeting_external_url: meetUrl ?? '',
        hubspot_owner_id: process.env.HUBSPOT_OWNER_ID ?? '',
      },
      associations: [],
    }),
  );

  await hsRetry(() =>
    hs.crm.associations.v4.basicApi.createDefault('meetings', meeting.id, 'companies', companyId),
  );
  await hsRetry(() =>
    hs.crm.associations.v4.basicApi.createDefault('meetings', meeting.id, 'deals', dealId),
  );
  const contactId = await findContactIdByEmail(attendeeEmail);
  if (contactId !== null) {
    await hsRetry(() =>
      hs.crm.associations.v4.basicApi.createDefault('meetings', meeting.id, 'contacts', contactId),
    );
  }

  await updateDealStage({ dealId, stageId: DEMO_DEAL_STAGE });

  const notePrefix = opts.source === 'outbound-ui-manual'
    ? `[Demo invite sent manually → ${attendeeEmail}]`
    : `[Demo booked → ${attendeeEmail}]`;
  await logHubspotNote({
    leadId: opts.leadId,
    companyId,
    body: notes !== '' ? `${notePrefix} ${notes}` : notePrefix,
  });

  const windowStart = new Date(startAtDate.getTime() - SOURCING_WINDOW_DAYS * MS_PER_DAY);
  const sourcing = await prisma.draft.findFirst({
    where: {
      leadId: opts.leadId,
      kind: { in: ATTRIBUTABLE_KINDS },
      status: { in: SENT_STATUSES },
      sentAt: { gte: windowStart, lte: new Date() },
    },
    orderBy: { sentAt: 'desc' },
    select: { id: true, kind: true },
  });

  await audit('meeting.booked', meeting.id, {
    leadId: opts.leadId,
    companyId,
    dealId,
    draftId: sourcing?.id ?? null,
    draftKind: sourcing?.kind ?? null,
    bucket: sourcing === null ? null : bucketForKind(sourcing.kind),
    bookedAt: new Date().toISOString(),
    startAt: startAtDate.toISOString(),
    meetUrl,
    attendeeEmail,
    source: opts.source,
  });

  await audit('outbound.demo-booked', opts.leadId, {
    meetingId: meeting.id,
    startAt: startAtDate.toISOString(),
    meetUrl,
    calendarEventId: opts.calendarEventId ?? null,
    attendeeEmail,
    manual: opts.source === 'outbound-ui-manual',
  });

  const seq = await getOutboundSequenceState(opts.leadId);
  if (seq.status === 'active') {
    if (seq.currentStep === 'cold-call-2') {
      await logOutboundTouch({
        leadId: opts.leadId,
        step: 'cold-call-2',
        outcome: 'demo-booked',
        notes,
      });
    }
    await audit('outbound.touch', opts.leadId, {
      step: 'demo',
      outcome: 'booked',
      notes: notes !== '' ? notes : undefined,
    });
  }

  return {
    meetingId: meeting.id,
    dealId,
    attendeeEmail,
    startAtIso: startAtDate.toISOString(),
  };
};
