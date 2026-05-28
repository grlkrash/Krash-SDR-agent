export const MS_PER_MIN = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

export const BRIEF_TIMEZONE = 'America/New_York';
export const SNIPPET_PLACEHOLDER = '_(snippet unavailable — open queue to view)_';

export const STATE_TZ = new Map<string, 'ET' | 'CT' | 'MT' | 'PT' | 'AK' | 'HI'>([
  ['CT', 'ET'], ['DC', 'ET'], ['DE', 'ET'], ['FL', 'ET'], ['GA', 'ET'],
  ['IN', 'ET'], ['KY', 'ET'], ['MA', 'ET'], ['MD', 'ET'], ['ME', 'ET'],
  ['MI', 'ET'], ['NC', 'ET'], ['NH', 'ET'], ['NJ', 'ET'], ['NY', 'ET'],
  ['OH', 'ET'], ['PA', 'ET'], ['RI', 'ET'], ['SC', 'ET'], ['TN', 'ET'],
  ['VA', 'ET'], ['VT', 'ET'], ['WV', 'ET'],
  ['AL', 'CT'], ['AR', 'CT'], ['IA', 'CT'], ['IL', 'CT'], ['KS', 'CT'],
  ['LA', 'CT'], ['MN', 'CT'], ['MO', 'CT'], ['MS', 'CT'], ['ND', 'CT'],
  ['NE', 'CT'], ['OK', 'CT'], ['SD', 'CT'], ['TX', 'CT'], ['WI', 'CT'],
  ['AZ', 'MT'], ['CO', 'MT'], ['ID', 'MT'], ['MT', 'MT'], ['NM', 'MT'],
  ['UT', 'MT'], ['WY', 'MT'],
  ['CA', 'PT'], ['NV', 'PT'], ['OR', 'PT'], ['WA', 'PT'],
  ['AK', 'AK'], ['HI', 'HI'],
]);

const TZ_HINT: Record<string, string> = {
  ET: 'call morning (ET)',
  CT: 'call mid-morning (CT)',
  MT: 'call late morning (MT)',
  PT: 'call afternoon (PT)',
  AK: 'call afternoon (AKT)',
  HI: 'call afternoon (HST)',
};

export const formatBriefDate = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: BRIEF_TIMEZONE }).format(d);

export const buildRelativeTime = (date: Date, now: Date): string => {
  const diff = Math.max(0, now.getTime() - date.getTime());
  if (diff < MS_PER_HOUR) {
    return `${Math.max(1, Math.round(diff / MS_PER_MIN))}m ago`;
  }
  if (diff < MS_PER_DAY) {
    return `${Math.max(1, Math.round(diff / MS_PER_HOUR))}h ago`;
  }
  return `${Math.max(1, Math.round(diff / MS_PER_DAY))}d ago`;
};

export const callHint = (state: string): string =>
  TZ_HINT[STATE_TZ.get(state.toUpperCase()) ?? ''] ?? 'call during local business hours';

export const formatPhoneForDisplay = (e164: string): string => {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (m === null) return e164;
  return `(${m[1]}) ${m[2]}-${m[3]}`;
};

export const cleanSnippet = (raw: string, maxLen: number): string => {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1)}…`;
};
