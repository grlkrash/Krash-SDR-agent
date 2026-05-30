// Post-generation quality gate for cold-email bodies and subjects. Complements
// the personalization evaluator with deterministic checks the grader won't
// reliably enforce.

export const COLD_BODY_MIN_WORDS = 120;
export const COLD_BODY_TARGET_MIN = 130;
export const COLD_BODY_TARGET_MAX = 165;

export const SUBJECT_MAX_WORDS = 6;
export const SUBJECT_MAX_CHARS = 50;

export type ColdEmailQualityIssue = 'too-short' | 'missing-ss-identity';

export type SubjectQualityIssue =
  | 'too-many-words'
  | 'too-many-chars'
  | 'missing-prospect-token'
  | 'vendor-pitch'
  | 'spam-pattern'
  | 'banned-word'
  | 'has-question'
  | 'has-exclamation';

export type ColdEmailQualityResult = {
  ok: boolean;
  issues: ColdEmailQualityIssue[];
  wordCount: number;
};

export type SubjectQualityResult = {
  ok: boolean;
  issues: SubjectQualityIssue[];
  wordCount: number;
  charCount: number;
};

export type ColdDraftQualityResult = {
  body: ColdEmailQualityResult;
  subject: SubjectQualityResult;
  ok: boolean;
};

export type SubjectProspectContext = {
  facilityName: string;
  city: string;
  state: string;
  ownerName?: string | null;
  services?: string[];
};

export const bodyWordCount = (body: string): number =>
  body.trim().split(/\s+/).filter((w) => w.length > 0).length;

export const subjectWordCount = (subject: string): number =>
  subject.trim().split(/\s+/).filter((w) => w.length > 0).length;

const SS_IDENTITY_MARKERS: ReadonlyArray<RegExp> = [
  /\bsobriety select\b/i,
  /\b(?:map-forward|region(?:al)?(?:ly)?|insurance)\b/i,
  /\b(?:profile|directory|families (?:actively )?search)\b/i,
  /\b(?:verified reviews|lead capture|open beds)\b/i,
];

const SUBJECT_VENDOR_PITCH_RX = /\b(?:increase visibility|sobriety\s*select|sobrietyselect\.com|directory placement|enhanced placement)\b/i;
const SUBJECT_BANNED_RX = /\b(?:visibility|revolutionary|game-changer|guaranteed|act now|100%|free!|synergy|leverage|unlock)\b/i;
const SUBJECT_SPAM_RX = /!{2,}|^[A-Z\s!]{8,}$/;

const countSsIdentityMarkers = (body: string): number =>
  SS_IDENTITY_MARKERS.filter((rx) => rx.test(body)).length;

const facilityTokens = (name: string): string[] =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !['center', 'centers', 'health', 'healthcare', 'treatment', 'services', 'recovery', 'behavioral'].includes(w));

export const assessColdEmailSubject = (
  subject: string,
  ctx: SubjectProspectContext,
): SubjectQualityResult => {
  const trimmed = subject.trim();
  const wordCount = subjectWordCount(trimmed);
  const charCount = trimmed.length;
  const issues: SubjectQualityIssue[] = [];
  const lower = trimmed.toLowerCase();

  if (wordCount > SUBJECT_MAX_WORDS) issues.push('too-many-words');
  if (charCount > SUBJECT_MAX_CHARS) issues.push('too-many-chars');
  if (trimmed.includes('?')) issues.push('has-question');
  if (trimmed.includes('!')) issues.push('has-exclamation');
  if (SUBJECT_VENDOR_PITCH_RX.test(lower)) issues.push('vendor-pitch');
  if (SUBJECT_BANNED_RX.test(lower)) issues.push('banned-word');
  if (SUBJECT_SPAM_RX.test(trimmed)) issues.push('spam-pattern');

  const cityHit = ctx.city.trim() !== '' && lower.includes(ctx.city.toLowerCase());
  const ownerFirst = ctx.ownerName?.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  const ownerHit = ownerFirst.length >= 3 && lower.includes(ownerFirst);
  const facilityHit = facilityTokens(ctx.facilityName).some((tok) => lower.includes(tok));
  const serviceHit = (ctx.services ?? []).some((s) => {
    const tok = s.toLowerCase().split(/\s+/)[0] ?? '';
    return tok.length >= 3 && lower.includes(tok);
  });

  if (!cityHit && !ownerHit && !facilityHit && !serviceHit) {
    issues.push('missing-prospect-token');
  }

  return { ok: issues.length === 0, issues, wordCount, charCount };
};

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

export const assessColdDraftQuality = (
  subject: string,
  body: string,
  ctx: SubjectProspectContext,
): ColdDraftQualityResult => {
  const bodyResult = assessColdEmailQuality(body);
  const subjectResult = assessColdEmailSubject(subject, ctx);
  return {
    body: bodyResult,
    subject: subjectResult,
    ok: bodyResult.ok && subjectResult.ok,
  };
};

export const buildSubjectRetryFeedback = (subject: SubjectQualityResult): string => {
  const parts: string[] = [];

  if (subject.issues.includes('vendor-pitch') || subject.issues.includes('banned-word')) {
    parts.push(
      'Subject reads like a vendor pitch. NEVER use "Increase Visibility", brand/domain names, or "visibility" in the subject. Sound like a colleague noting a census or intake observation.',
    );
  }
  if (subject.issues.includes('missing-prospect-token')) {
    parts.push('Subject must include this prospect\'s city, a distinctive facility word, owner first name, or service line.');
  }
  if (subject.issues.includes('too-many-words') || subject.issues.includes('too-many-chars')) {
    parts.push(`Subject is ${subject.wordCount} words / ${subject.charCount} chars. Max ${SUBJECT_MAX_WORDS} words and ${SUBJECT_MAX_CHARS} characters for mobile preview.`);
  }
  if (subject.issues.includes('has-question') || subject.issues.includes('has-exclamation')) {
    parts.push('No question marks or exclamation points in the subject — healthcare filters flag them.');
  }
  if (subject.issues.includes('spam-pattern')) {
    parts.push('Subject triggers spam patterns (all caps or multiple exclamation marks). Use lowercase colleague tone.');
  }

  return parts.join(' ');
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

export const buildDraftQualityRetryFeedback = (draft: ColdDraftQualityResult): string => {
  const parts: string[] = [];
  const bodyFb = buildQualityRetryFeedback(draft.body);
  const subjectFb = buildSubjectRetryFeedback(draft.subject);
  if (bodyFb !== '') parts.push(bodyFb);
  if (subjectFb !== '') parts.push(subjectFb);
  return parts.join(' ');
};
