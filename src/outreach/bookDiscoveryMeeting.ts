// Book a discovery demo from /outbound. Sends a Google Calendar invite with
// Meet to the client email, then mirrors the meeting in HubSpot for tracking.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { hs, hsRetry } from '../shared/hubspot.js';
import { ensureDealForLead } from '../shared/ensureHubspotDeal.js';
import {
  createCalendarEventWithMeet,
  hasCalendarScope,
} from '../shared/googleCalendar.js';
import { findContactIdByEmail } from '../shared/hubspotLinks.js';
import { updateDealStage } from '../shared/hubspotDealStages.js';
import { logHubspotNote } from '../shared/logHubspotNote.js';
import { parseDemoDatetimeLocal, wallEndFromDuration } from '../shared/parseDemoDatetime.js';
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

export type BookDiscoveryResult = {
  meetingId: string;
  dealId: string;
  meetUrl: string | null;
  calendarEventId: string | null;
  calendarInviteSent: boolean;
  attendeeEmail: string;
};

export const bookDiscoveryMeeting = async (opts: {
  leadId: string;
  startAtLocal: string;
  durationMinutes?: number;
  attendeeEmail: string;
  notes?: string;
}): Promise<BookDiscoveryResult> => {
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
  const startWall = parseDemoDatetimeLocal(opts.startAtLocal);
  const endWall = wallEndFromDuration(startWall, durationMinutes);
  const title = `Sobriety Select discovery — ${lead.name}`;
  const notes = opts.notes?.trim() ?? '';
  const bodyParts = [
    `Discovery demo with ${lead.name} (${lead.city}, ${lead.state}).`,
    notes !== '' ? `Notes: ${notes}` : '',
  ].filter((p) => p !== '');
  const meetingBody = bodyParts.join('\n\n');

  let meetUrl: string | null = null;
  let calendarEventId: string | null = null;
  let calendarHtmlLink: string | null = null;
  let startAtIso: string | null = null;
  let calendarInviteSent = false;

  const scopeOk = await hasCalendarScope();
  if (!scopeOk) {
    throw new Error(
      'Google Calendar scope missing on GMAIL_REFRESH_TOKEN. Run: npx tsx src/scripts/gmailAuth.ts',
    );
  }

  const cal = await createCalendarEventWithMeet({
    title,
    description: meetingBody,
    start: startWall,
    end: endWall,
    attendeeEmail,
  });
  meetUrl = cal.meetUrl;
  calendarEventId = cal.eventId;
  calendarHtmlLink = cal.htmlLink;
  startAtIso = cal.startAtIso;
  calendarInviteSent = true;
  await audit('outbound.calendar-created', opts.leadId, {
    eventId: cal.eventId,
    meetUrl: cal.meetUrl,
    htmlLink: cal.htmlLink,
    attendeeEmail,
  });

  const startAt = startAtIso !== null ? new Date(startAtIso) : new Date();
  const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);

  const meeting = await hsRetry(() =>
    hs.crm.objects.meetings.basicApi.create({
      properties: {
        hs_timestamp: startAt.getTime().toString(),
        hs_meeting_start_time: startAt.toISOString(),
        hs_meeting_end_time: endAt.toISOString(),
        hs_meeting_title: title,
        hs_meeting_body: meetingBody,
        hs_meeting_outcome: HUBSPOT_MEETING_OUTCOME,
        hs_meeting_location: meetUrl ?? 'Google Meet',
        hs_meeting_external_url: calendarHtmlLink ?? meetUrl ?? '',
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

  if (notes !== '') {
    await logHubspotNote({
      leadId: opts.leadId,
      companyId,
      body: `[Demo booked → ${attendeeEmail}] ${notes}`,
    });
  }

  const windowStart = new Date(startAt.getTime() - SOURCING_WINDOW_DAYS * MS_PER_DAY);
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
    startAt: startAt.toISOString(),
    meetUrl,
    attendeeEmail,
    source: 'outbound-ui',
  });

  await audit('outbound.demo-booked', opts.leadId, {
    meetingId: meeting.id,
    startAt: startAt.toISOString(),
    meetUrl,
    calendarEventId,
    attendeeEmail,
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
    meetUrl,
    calendarEventId,
    calendarInviteSent,
    attendeeEmail,
  };
};
