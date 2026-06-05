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

/** Convert a datetime-local value (interpreted as Eastern) to a UTC Date. */
export const wallEtToUtcDate = (startAtLocal: string): Date => {
  const { dateTime } = parseDemoDatetimeLocal(startAtLocal);
  const [datePart, timePart] = dateTime.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  for (let utcH = 0; utcH < 24; utcH += 1) {
    for (const utcD of [d - 1, d, d + 1]) {
      const probe = new Date(Date.UTC(y, mo - 1, utcD, utcH, mi, 0));
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: DEMO_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(probe);
      const read = (type: string): number =>
        Number(parts.find((p) => p.type === type)?.value ?? '0');
      if (
        read('year') === y
        && read('month') === mo
        && read('day') === d
        && read('hour') === h
        && read('minute') === mi
      ) {
        return probe;
      }
    }
  }
  return new Date();
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
