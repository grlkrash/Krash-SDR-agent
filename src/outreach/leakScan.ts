// Post-generation guard for cold-email bodies. The COLD_EMAIL_SYSTEM prompt
// forbids SS prices, dollar amounts, "Claimed/Select/Premium" tier names, and
// per-year/month framings — but prompt obedience is not enforced. This is the
// hard binary gate that runs after each generate() and skips the draft when
// the model violates the absolute SS-pricing rule.
//
// Industry YoY stats about paid-search inflation (124%/62%) are ALLOWED in the
// email; those sentences are stripped from the scan copy so "cost" in an
// industry-context sentence does not false-positive.
//
// `ignoreSubstrings` exists so callers can strip expected-legitimate
// occurrences (e.g. a facility named "Premium Recovery") before matching,
// preventing the obvious false positives on tier-name scans.

export type LeakHit = { label: string; match: string };

// Company name contains "Select" — strip before tier-name scan.
const BRAND_SAFE_PHRASES = ['Sobriety Select'] as const;

const LEAK_PATTERNS: ReadonlyArray<{ label: string; rx: RegExp }> = [
  { label: 'dollar amount', rx: /\$\s?\d/ },
  { label: 'pricing word', rx: /\b(?:price|pricing|cost|costs|fee|fees|dollars?|USD)\b/i },
  { label: 'per-year/month framing', rx: /\b\d[\d,]*\s*(?:\/\s*(?:yr|mo|year|month)|per\s+(?:year|month))\b/i },
  { label: 'capitalized tier name', rx: /\b(?:Claimed|Select|Premium)\b/ },
];

// Sentences citing deck-verified industry inflation stats — safe for leak scan.
const INDUSTRY_YOY_STAT_RX = /\d{1,3}\s*%\s*(?:year\s*over\s*year|year-over-year|\byoy\b)/i;
const INDUSTRY_CONTEXT_RX = /\b(?:paid search|keyword auction|drug rehab|advertis|google ads|restricted channel|few places|operators|channels|auctions?)\b/i;

const isAllowedIndustryCostSentence = (trimmed: string): boolean =>
  /\b(?:cost|costs|pricier|expensive|bidding)\b/i.test(trimmed)
  && (
    INDUSTRY_CONTEXT_RX.test(trimmed)
    || /\b(?:families searching|intake|census|operators in|competing on|affordable channels)\b/i.test(trimmed)
  );

// Strip market-context pricing words from the scan copy. SS-pricing leaks keep
// dollar amounts or "Sobriety Select" in the same sentence.
const stripMarketCostSentences = (body: string): string => {
  const sentences = body.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => {
    const trimmed = sentence.trim();
    if (trimmed === '') return false;
    if (!/\b(?:cost|costs|pricier|expensive|fee|fees|pricing|price)\b/i.test(trimmed)) return true;
    if (/\$\s?\d/.test(trimmed)) return true;
    if (/\bsobriety select\b/i.test(trimmed)) return true;
    return false;
  });
  return kept.join(' ');
};

const stripSubstrings = (body: string, ignoreSubstrings: string[]): string => {
  let cleaned = body;
  for (const ignore of ignoreSubstrings) {
    const trimmed = ignore.trim();
    if (trimmed === '') continue;
    cleaned = cleaned.split(trimmed).join('');
  }
  return cleaned;
};

// Remove allowed industry-stat and market-pressure sentences from the scan
// copy only — the live email body is unchanged.
const stripIndustryStatSentences = (body: string): string => {
  const sentences = body.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((sentence) => {
    const trimmed = sentence.trim();
    if (trimmed === '') return false;
    const isIndustryStat =
      INDUSTRY_YOY_STAT_RX.test(trimmed) && INDUSTRY_CONTEXT_RX.test(trimmed);
    return !isIndustryStat && !isAllowedIndustryCostSentence(trimmed);
  });
  return kept.join(' ');
};

const prepareForLeakScan = (body: string, ignoreSubstrings: string[]): string => {
  const withoutSafe = stripSubstrings(body, [...BRAND_SAFE_PHRASES, ...ignoreSubstrings]);
  return stripMarketCostSentences(stripIndustryStatSentences(withoutSafe));
};

export const scanLeaks = (
  body: string,
  ignoreSubstrings: string[] = [],
): LeakHit[] => {
  const cleaned = prepareForLeakScan(body, ignoreSubstrings);
  return LEAK_PATTERNS.flatMap((p) => {
    const m = cleaned.match(p.rx);
    return m === null ? [] : [{ label: p.label, match: m[0] }];
  });
};
