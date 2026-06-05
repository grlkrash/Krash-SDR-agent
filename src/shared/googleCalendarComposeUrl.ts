// Opens Google Calendar's "create event" page with fields pre-filled — no API
// key or Calendar API enablement required. Sonia adds Meet and sends the invite
// manually, then clicks "Mark invite sent" back on /outbound.

import { parseDemoDatetimeLocal, wallEndFromDuration } from './parseDemoDatetime.js';

const COMPOSE_BASE = 'https://calendar.google.com/calendar/render';

const toGoogleDates = (startLocal: string, durationMinutes: number): string => {
  const startWall = parseDemoDatetimeLocal(startLocal);
  const endWall = wallEndFromDuration(startWall, durationMinutes);
  const compact = (isoLocal: string): string =>
    isoLocal.replace(/-/g, '').replace(/:/g, '');
  return `${compact(startWall.dateTime)}/${compact(endWall.dateTime)}`;
};

export const buildGoogleCalendarComposeUrl = (opts: {
  title: string;
  description: string;
  startAtLocal: string;
  durationMinutes: number;
  attendeeEmail: string;
}): string => {
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: opts.title,
    dates: toGoogleDates(opts.startAtLocal, opts.durationMinutes),
    details: opts.description,
    add: opts.attendeeEmail.trim(),
  });
  return `${COMPOSE_BASE}?${params.toString()}`;
};
