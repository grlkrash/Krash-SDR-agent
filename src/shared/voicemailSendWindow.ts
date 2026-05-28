// After-hours send gate for vm-1 (first-touch AMD drops).
//
// Treatment-center main lines are usually answered live during business hours.
// Vm-1 sends only outside local Mon–Fri 9 AM–6 PM, or anytime Sat/Sun, so AMD
// is more likely to reach a voicemail box. Vm-2 has no window — live bridge
// during business hours is intentional.
//
// Timezone is inferred from Lead.state via a coarse US state → IANA map (same
// buckets as the daily brief). Unknown state → defer (do not dial).

const VM1_BUSINESS_START_HOUR = 9;
const VM1_BUSINESS_END_HOUR = 18;

const STATE_IANA: Record<string, string> = {
  CT: 'America/New_York', DC: 'America/New_York', DE: 'America/New_York',
  FL: 'America/New_York', GA: 'America/New_York', IN: 'America/New_York',
  KY: 'America/New_York', MA: 'America/New_York', MD: 'America/New_York',
  ME: 'America/New_York', MI: 'America/New_York', NC: 'America/New_York',
  NH: 'America/New_York', NJ: 'America/New_York', NY: 'America/New_York',
  OH: 'America/New_York', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', TN: 'America/New_York', VA: 'America/New_York',
  VT: 'America/New_York', WV: 'America/New_York',
  AL: 'America/Chicago', AR: 'America/Chicago', IA: 'America/Chicago',
  IL: 'America/Chicago', KS: 'America/Chicago', LA: 'America/Chicago',
  MN: 'America/Chicago', MO: 'America/Chicago', MS: 'America/Chicago',
  ND: 'America/Chicago', NE: 'America/Chicago', OK: 'America/Chicago',
  SD: 'America/Chicago', TX: 'America/Chicago', WI: 'America/Chicago',
  AZ: 'America/Denver', CO: 'America/Denver', ID: 'America/Denver',
  MT: 'America/Denver', NM: 'America/Denver', UT: 'America/Denver',
  WY: 'America/Denver',
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles',
  WA: 'America/Los_Angeles',
  AK: 'America/Anchorage',
  HI: 'Pacific/Honolulu',
};

export type Vm1SendWindowResult =
  | { allowed: true; timezone: string }
  | { allowed: false; reason: string; timezone: string | null };

type LocalClock = {
  hour: number;
  weekday: string;
};

const parsePart = (parts: Intl.DateTimeFormatPart[], type: string): string =>
  parts.find((p) => p.type === type)?.value ?? '';

const getLocalClock = (now: Date, timezone: string): LocalClock => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);
  return {
    hour: Number(parsePart(parts, 'hour')),
    weekday: parsePart(parts, 'weekday'),
  };
};

export const isVm1SendWindowOpen = (
  state: string | null,
  now: Date = new Date(),
): Vm1SendWindowResult => {
  const normalized = state?.toUpperCase().trim() ?? '';
  const timezone = STATE_IANA[normalized];
  if (timezone === undefined) {
    return { allowed: false, reason: 'unknown-state-timezone', timezone: null };
  }

  const { hour, weekday } = getLocalClock(now, timezone);
  if (weekday === 'Sat' || weekday === 'Sun') {
    return { allowed: true, timezone };
  }

  if (hour >= VM1_BUSINESS_START_HOUR && hour < VM1_BUSINESS_END_HOUR) {
    return { allowed: false, reason: 'business-hours-vm1-deferred', timezone };
  }

  return { allowed: true, timezone };
};
