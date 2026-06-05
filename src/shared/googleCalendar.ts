// Google Calendar + Meet for discovery demos. Reuses Gmail OAuth with
// calendar.events scope (re-run gmailAuth.ts after adding scope).

import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import type { DemoWallTime } from './parseDemoDatetime.js';

const MEET_REQUEST_ID_PREFIX = 'ssa-demo-';

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
};

const buildOAuthClient = (): OAuth2Client => {
  const client = new google.auth.OAuth2({
    clientId: requireEnv('GMAIL_CLIENT_ID'),
    clientSecret: requireEnv('GMAIL_CLIENT_SECRET'),
  });
  client.setCredentials({ refresh_token: requireEnv('GMAIL_REFRESH_TOKEN') });
  return client;
};

export type CalendarEventResult = {
  eventId: string;
  htmlLink: string;
  meetUrl: string | null;
  startAtIso: string | null;
};

export const createCalendarEventWithMeet = async (opts: {
  title: string;
  description: string;
  start: DemoWallTime;
  end: DemoWallTime;
  attendeeEmail: string;
}): Promise<CalendarEventResult> => {
  const attendee = opts.attendeeEmail.trim();
  if (attendee === '') throw new Error('Client email is required to send the calendar invite');

  const auth = buildOAuthClient();
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = process.env.GOOGLE_CALENDAR_ID?.trim() || 'primary';
  const requestId = `${MEET_REQUEST_ID_PREFIX}${opts.start.dateTime}`;

  const created = await calendar.events.insert({
    calendarId,
    conferenceDataVersion: 1,
    sendUpdates: 'all',
    requestBody: {
      summary: opts.title,
      description: opts.description,
      start: { dateTime: opts.start.dateTime, timeZone: opts.start.timeZone },
      end: { dateTime: opts.end.dateTime, timeZone: opts.end.timeZone },
      attendees: [{ email: attendee }],
      conferenceData: {
        createRequest: {
          requestId,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    },
  });

  const eventId = created.data.id;
  if (eventId === null || eventId === undefined) {
    throw new Error('Google Calendar did not return an event id');
  }

  const meetEntry = created.data.conferenceData?.entryPoints?.find(
    (e) => e.entryPointType === 'video',
  );
  const meetUrl = meetEntry?.uri ?? created.data.hangoutLink ?? null;
  const htmlLink = created.data.htmlLink ?? '';
  const startAtIso = created.data.start?.dateTime ?? null;

  return { eventId, htmlLink, meetUrl, startAtIso };
};

export const hasCalendarCredentials = (): boolean => {
  const id = process.env.GMAIL_CLIENT_ID?.trim() ?? '';
  const secret = process.env.GMAIL_CLIENT_SECRET?.trim() ?? '';
  const refresh = process.env.GMAIL_REFRESH_TOKEN?.trim() ?? '';
  return id !== '' && secret !== '' && refresh !== '';
};

let calendarScopeOk: boolean | null = null;

export const hasCalendarScope = async (): Promise<boolean> => {
  if (!hasCalendarCredentials()) return false;
  if (calendarScopeOk !== null) return calendarScopeOk;
  try {
    const auth = buildOAuthClient();
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.list({ calendarId: 'primary', maxResults: 1 });
    calendarScopeOk = true;
    return true;
  } catch {
    calendarScopeOk = false;
    return false;
  }
};
