/** PRD §9.1 — times are Eastern (America/New_York). Railway cron tick runs every 5 min UTC. */

export type CronJobKind = 'daily' | 'weekly' | 'interval';

export type CronJobDef = {
  name: string;
  kind: CronJobKind;
  /** Eastern hour 0–23 */
  etHour?: number;
  /** Eastern minute 0–59 */
  etMinute?: number;
  /** 1=Mon … 7=Sun (weekly jobs only) */
  etWeekday?: number;
  intervalMinutes?: number;
  modulePath: string;
  /** false until the script exists in src/scripts/ */
  enabled: boolean;
};

export const CRON_JOBS: CronJobDef[] = [
  { name: 'dailyScrape', kind: 'daily', etHour: 5, etMinute: 0, modulePath: './dailyScrape.js', enabled: true },
  { name: 'enrichAll', kind: 'daily', etHour: 5, etMinute: 30, modulePath: './enrichAll.js', enabled: true },
  { name: 'syncToHubspot', kind: 'daily', etHour: 5, etMinute: 45, modulePath: './syncToHubspot.js', enabled: true },
  { name: 'scorePipeline', kind: 'daily', etHour: 6, etMinute: 0, modulePath: './scorePipeline.js', enabled: true },
  {
    name: 'syncDirectoryExclusions',
    kind: 'daily',
    etHour: 6,
    etMinute: 15,
    modulePath: './syncDirectoryExclusions.js',
    enabled: true,
  },
  { name: 'draftColdBatch', kind: 'daily', etHour: 6, etMinute: 30, modulePath: './draftColdBatch.js', enabled: true },
  { name: 'draftFollowups', kind: 'daily', etHour: 7, etMinute: 0, modulePath: './draftFollowups.js', enabled: true },
  { name: 'runSecondCalls', kind: 'daily', etHour: 7, etMinute: 15, modulePath: './runSecondCalls.js', enabled: true },
  { name: 'runSequences', kind: 'daily', etHour: 7, etMinute: 30, modulePath: './runSequences.js', enabled: true },
  { name: 'draftUpsellBatch', kind: 'daily', etHour: 8, etMinute: 0, modulePath: './draftUpsellBatch.js', enabled: true },
  { name: 'quarterlyCheckins', kind: 'daily', etHour: 9, etMinute: 0, modulePath: './quarterlyCheckins.js', enabled: true },
  {
    name: 'syncDealRenewalDates',
    kind: 'daily',
    etHour: 9,
    etMinute: 45,
    modulePath: './syncDealRenewalDates.js',
    enabled: true,
  },
  { name: 'renewalWarnings', kind: 'daily', etHour: 10, etMinute: 0, modulePath: './renewalWarnings.js', enabled: true },
  { name: 'dropVoicemails', kind: 'daily', etHour: 14, etMinute: 0, modulePath: './dropVoicemails.js', enabled: true },
  // Every Railway cron tick (*/5 UTC): isDueNow uses minute % 5 < 5; shouldSkip
  // enforces ≥4.5 min between runs — ~5 min reply detection cadence.
  { name: 'checkReplies', kind: 'interval', intervalMinutes: 5, modulePath: './checkReplies.js', enabled: true },
  { name: 'sendApproved', kind: 'interval', intervalMinutes: 10, modulePath: './sendApproved.js', enabled: true },
  { name: 'sendDailyBrief', kind: 'daily', etHour: 17, etMinute: 0, modulePath: './sendDailyBrief.js', enabled: true },
  { name: 'checkCostCaps', kind: 'daily', etHour: 17, etMinute: 30, modulePath: './checkCostCaps.js', enabled: true },
  { name: 'reactivation', kind: 'weekly', etWeekday: 1, etHour: 3, etMinute: 0, modulePath: './reactivation.js', enabled: true },
  {
    name: 'refreshGoogleSignals',
    kind: 'weekly',
    etWeekday: 1,
    etHour: 4,
    etMinute: 0,
    modulePath: './refreshGoogleSignals.js',
    enabled: true,
  },
];

export type EtClock = {
  hour: number;
  minute: number;
  weekday: number;
  dateKey: string;
};

const ET = 'America/New_York';

const parsePart = (parts: Intl.DateTimeFormatPart[], type: string): string =>
  parts.find((p) => p.type === type)?.value ?? '';

export const getEtClock = (d: Date): EtClock => {
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(d);
  const timeParts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const weekdayRaw = parsePart(dateParts, 'weekday');
  const weekdayMap: Record<string, number> = {
    Sun: 7,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    hour: Number(parsePart(timeParts, 'hour')),
    minute: Number(parsePart(timeParts, 'minute')),
    weekday: weekdayMap[weekdayRaw] ?? 0,
    dateKey: `${parsePart(dateParts, 'year')}-${parsePart(dateParts, 'month')}-${parsePart(dateParts, 'day')}`,
  };
};

/** True when the current 5-min Railway tick should fire this job. */
export const isDueNow = (job: CronJobDef, clock: EtClock): boolean => {
  if (!job.enabled) return false;

  if (job.kind === 'interval') {
    const interval = job.intervalMinutes ?? 0;
    if (interval <= 0) return false;
    return clock.minute % interval < 5;
  }

  if (job.etHour === undefined || job.etMinute === undefined) return false;
  if (clock.hour !== job.etHour) return false;
  if (clock.minute < job.etMinute || clock.minute >= job.etMinute + 5) return false;
  if (job.kind === 'weekly' && job.etWeekday !== undefined && clock.weekday !== job.etWeekday) {
    return false;
  }
  return true;
};
