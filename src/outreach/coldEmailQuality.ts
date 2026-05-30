// Post-generation quality gate for cold-email bodies. Complements the
// personalization evaluator with deterministic checks the grader won't
// reliably enforce (word count floor, SS identity paragraph present).

export const COLD_BODY_MIN_WORDS = 120;
export const COLD_BODY_TARGET_MIN = 130;
export const COLD_BODY_TARGET_MAX = 165;

export type ColdEmailQualityIssue = 'too-short' | 'missing-ss-identity';

export type ColdEmailQualityResult = {
  ok: boolean;
  issues: ColdEmailQualityIssue[];
  wordCount: number;
};

export const bodyWordCount = (body: string): number =>
  body.trim().split(/\s+/).filter((w) => w.length > 0).length;

// At least two distinct SS-identity signals — proves the "who we are" bridge
// landed, not just a one-line value prop.
const SS_IDENTITY_MARKERS: ReadonlyArray<RegExp> = [
  /\bsobriety select\b/i,
  /\b(?:map-forward|region(?:al)?(?:ly)?|insurance)\b/i,
  /\b(?:profile|directory|families (?:actively )?search)\b/i,
  /\b(?:verified reviews|lead capture|open beds)\b/i,
];

const countSsIdentityMarkers = (body: string): number =>
  SS_IDENTITY_MARKERS.filter((rx) => rx.test(body)).length;

export const assessColdEmailQuality = (body: string): ColdEmailQualityResult => {
  const wordCount = bodyWordCount(body);
  const issues: ColdEmailQualityIssue[] = [];

  if (wordCount < COLD_BODY_MIN_WORDS) {
    issues.push('too-short');
  }
  if (countSsIdentityMarkers(body) < 2) {
    issues.push('missing-ss-identity');
  }

  return { ok: issues.length === 0, issues, wordCount };
};

export const buildQualityRetryFeedback = (quality: ColdEmailQualityResult): string => {
  const parts: string[] = [];

  if (quality.issues.includes('too-short')) {
    parts.push(
      `Body is only ${quality.wordCount} words. HARD MINIMUM is ${COLD_BODY_MIN_WORDS} words; target ${COLD_BODY_TARGET_MIN}-${COLD_BODY_TARGET_MAX}. Add the MARKET PAIN paragraph (paid-search inflation 124%/62% YoY for select/premium tiers, or restricted ad channels for claimed) AND the SS IDENTITY paragraph (map-forward directory, region + insurance discovery, rich profiles, complements existing marketing). Use concise prose paragraphs, not bullet dumps.`,
    );
  }
  if (quality.issues.includes('missing-ss-identity')) {
    parts.push(
      'Missing Sobriety Select identity — include at least 2 sentences explaining what SS is (trusted map-forward directory, families search by region and insurance, rich profiles with services/insurance/reviews, works alongside existing marketing without paid-search bidding wars).',
    );
  }

  return parts.join(' ');
};
