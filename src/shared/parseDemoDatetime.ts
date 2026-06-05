// datetime-local from /outbound has no timezone — interpret as US/Eastern.

export const DEMO_TZ = 'America/New_York';

export type DemoWallTime = {
  dateTime: string;
  timeZone: string;
};

export const parseDemoDatetimeLocal = (raw: string): DemoWallTime => {
  const trimmed = raw.trim();
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})$/.exec(trimmed);
  if (match === null) throw new Error('Invalid demo start time — use the date/time picker');
  return { dateTime: `${match[1]}:00`, timeZone: DEMO_TZ };
};

export const wallEndFromDuration = (start: DemoWallTime, durationMinutes: number): DemoWallTime => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(start.dateTime);
  if (m === null) throw new Error('Invalid wall time');
  const [, datePart, hh, mm] = m;
  const totalMin = Number(hh) * 60 + Number(mm) + durationMinutes;
  const endH = Math.floor(totalMin / 60) % 24;
  const endM = totalMin % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    dateTime: `${datePart}T${pad(endH)}:${pad(endM)}:00`,
    timeZone: start.timeZone,
  };
};
