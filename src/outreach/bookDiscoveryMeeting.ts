// Auto-book: Google Calendar invite with Meet + HubSpot mirror.
// Manual fallback: see markDemoInviteSent + open-calendar route in outbound UI.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  createCalendarEventWithMeet,
  hasCalendarScope,
} from '../shared/googleCalendar.js';
import { parseDemoDatetimeLocal, wallEndFromDuration } from '../shared/parseDemoDatetime.js';
import { recordDemoMeeting } from './recordDemoMeeting.js';

const DEFAULT_DURATION_MIN = 30;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

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
  const durationMinutes = opts.durationMinutes ?? DEFAULT_DURATION_MIN;
  const scopeOk = await hasCalendarScope();
  if (!scopeOk) {
    throw new Error(
      'Google Calendar API unavailable. Use "Open Google Calendar" then "Mark invite sent" on /outbound.',
    );
  }

  const lead = await prisma.lead.findUnique({ where: { id: opts.leadId } });
  if (lead === null) throw new Error('Lead not found');
  const startWall = parseDemoDatetimeLocal(opts.startAtLocal);
  const endWall = wallEndFromDuration(startWall, durationMinutes);
  const title = `Sobriety Select discovery — ${lead.name}`;
  const notes = opts.notes?.trim() ?? '';
  const meetingBody = [
    `Discovery demo with ${lead.name} (${lead.city}, ${lead.state}).`,
    notes !== '' ? notes : '',
  ].filter((p) => p !== '').join('\n\n');

  const cal = await createCalendarEventWithMeet({
    title,
    description: meetingBody,
    start: startWall,
    end: endWall,
    attendeeEmail,
  });

  const startAtOverride = cal.startAtIso !== null ? new Date(cal.startAtIso) : undefined;

  const recorded = await recordDemoMeeting({
    leadId: opts.leadId,
    startAtLocal: opts.startAtLocal,
    durationMinutes,
    attendeeEmail,
    notes: opts.notes,
    source: 'outbound-ui-auto',
    meetUrl: cal.meetUrl,
    calendarEventId: cal.eventId,
    startAtOverride,
  });

  return {
    meetingId: recorded.meetingId,
    dealId: recorded.dealId,
    meetUrl: cal.meetUrl,
    calendarEventId: cal.eventId,
    calendarInviteSent: true,
    attendeeEmail: recorded.attendeeEmail,
  };
};

export const markDemoInviteSent = async (opts: {
  leadId: string;
  startAtLocal: string;
  durationMinutes?: number;
  attendeeEmail: string;
  notes?: string;
}): Promise<BookDiscoveryResult> => {
  const recorded = await recordDemoMeeting({
    leadId: opts.leadId,
    startAtLocal: opts.startAtLocal,
    durationMinutes: opts.durationMinutes,
    attendeeEmail: opts.attendeeEmail,
    notes: opts.notes,
    source: 'outbound-ui-manual',
    meetUrl: null,
    calendarEventId: null,
  });
  return {
    meetingId: recorded.meetingId,
    dealId: recorded.dealId,
    meetUrl: null,
    calendarEventId: null,
    calendarInviteSent: false,
    attendeeEmail: recorded.attendeeEmail,
  };
};
