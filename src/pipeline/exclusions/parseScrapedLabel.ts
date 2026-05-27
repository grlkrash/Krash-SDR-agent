// Parse facility labels from sobrietyselect.com/centers card text
// (name + city + state are often glued together in the DOM).

const US_STATE_ABBR: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY',
};

export const normalizeUsState = (raw: string): string | null => {
  const s = raw.trim();
  if (s.length === 2) return s.toUpperCase();
  return US_STATE_ABBR[s.toLowerCase()] ?? null;
};

export const baseFacilityName = (name: string): string =>
  name.replace(/\s*\([^)]+\)\s*$/, '').trim();

export const parseScrapedLabel = (
  raw: string,
): { name: string; city: string | null; state: string | null } => {
  let s = raw.replace(/Insurance accepted/gi, '').replace(/\s+/g, ' ').trim();
  const lastComma = s.lastIndexOf(',');
  if (lastComma < 0) return { name: s, city: null, state: null };
  const state = normalizeUsState(s.slice(lastComma + 1).trim());
  const before = s.slice(0, lastComma).trim();

  const paren = before.match(/^(.+?)\(([^)]+)\)\s*(.*)$/);
  if (paren !== null) {
    const base = paren[1].trim();
    const city = paren[2].trim();
    const tail = paren[3].trim();
    const name = tail === '' || tail === city ? `${base} (${city})` : before;
    return { name, city, state };
  }

  const glued = before.match(/^(.+?[a-z0-9)])([A-Z][A-Za-z' .-]+)$/);
  if (glued !== null) {
    return { name: glued[1].trim(), city: glued[2].trim(), state };
  }

  return { name: before, city: null, state };
};
