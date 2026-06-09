// date input from disposition forms — due at 9:00 AM US/Eastern.

import { DEMO_TZ, wallEtToUtcDate } from './parseDemoDatetime.js';

export const FOLLOW_UP_TZ = DEMO_TZ;
const FOLLOW_UP_TIME_LOCAL = 'T09:00';

export const parseFollowUpDateLocal = (raw: string): Date => {
  const trimmed = raw.trim();
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(trimmed);
  if (dateOnly !== null) {
    return wallEtToUtcDate(`${dateOnly[1]}${FOLLOW_UP_TIME_LOCAL}`);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) {
    return wallEtToUtcDate(trimmed);
  }
  throw new Error('Invalid follow-up date/time — use the calendar picker');
};
