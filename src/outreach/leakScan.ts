// Post-generation guard for cold-email bodies. The COLD_EMAIL_SYSTEM prompt
// forbids prices, dollar amounts, "Claimed/Select/Premium" tier names, and
// per-year/month framings — but prompt obedience is not enforced. This is the
// hard binary gate that runs after each generate() and skips the draft when
// the model violates the absolute pricing rule.
//
// `ignoreSubstrings` exists so callers can strip expected-legitimate
// occurrences (e.g. a facility named "Premium Recovery") before matching,
// preventing the obvious false positives on tier-name scans.

export type LeakHit = { label: string; match: string };

const LEAK_PATTERNS: ReadonlyArray<{ label: string; rx: RegExp }> = [
  { label: 'dollar amount', rx: /\$\s?\d/ },
  { label: 'pricing word', rx: /\b(?:price|pricing|cost|costs|fee|fees|dollars?|USD)\b/i },
  { label: 'per-year/month framing', rx: /\b\d[\d,]*\s*(?:\/\s*(?:yr|mo|year|month)|per\s+(?:year|month))\b/i },
  { label: 'capitalized tier name', rx: /\b(?:Claimed|Select|Premium)\b/ },
];

const stripSubstrings = (body: string, ignoreSubstrings: string[]): string => {
  let cleaned = body;
  for (const ignore of ignoreSubstrings) {
    const trimmed = ignore.trim();
    if (trimmed === '') continue;
    cleaned = cleaned.split(trimmed).join('');
  }
  return cleaned;
};

export const scanLeaks = (
  body: string,
  ignoreSubstrings: string[] = [],
): LeakHit[] => {
  const cleaned = stripSubstrings(body, ignoreSubstrings);
  return LEAK_PATTERNS.flatMap((p) => {
    const m = cleaned.match(p.rx);
    return m === null ? [] : [{ label: p.label, match: m[0] }];
  });
};
