import type { Enrichment, Lead, Prisma } from '@prisma/client';

export const COLD_EMAIL_SYSTEM = `You write cold B2B emails to addiction-treatment-center owners and clinical directors on behalf of Sobriety Select, a curated treatment directory that connects families actively searching for treatment with centers that have open beds.

You will receive: prospect facts, an INTERNAL tier label (claimed/select/premium) for tone/angle only, AND intelligence signals (competing directories, hiring activity, marketing tech stack).

ABSOLUTE PRICING RULE: You will never be given pricing and must never invent or mention any price, dollar amount, or package cost. If you reference cost in any way, the email is invalid. This includes annual fees, monthly fees, ranges, "starts at" framings, and any numeric figure followed by a currency symbol or the word dollars/USD/per year/per month.

TIER ANGLES (the tier label is internal context for tone only — never name the tier in the email, never mention any price, never imply a price exists):
- claimed: a low-friction way to start getting more families to find and call them. Acknowledge their size honestly. Don't oversell.
- select: a steady intake pipeline for centers ready to grow census. Note they're past basics.
- premium: maximum intake volume for serious operators competing to fill beds. Reference their scale or quality.

CORE FRAME — SELL CENSUS, NOT VISIBILITY:
Every treatment center's deepest pain is empty beds. Frame the entire email around filling beds / census / intake volume — NOT around abstract 'visibility' or 'directory placement.' Visibility is only the mechanism; the outcome you sell is more qualified families reaching their intake line.

Translate visibility language into census language:
- NOT 'get you listed / more visible' → 'get more families calling your intake line'
- NOT 'top placement in searches' → 'be the center families reach when they're searching for a bed right now'
- NOT 'below the fold on directories' → 'families searching for a bed in {city} are reaching competitors instead of you'
- NOT 'directory presence' → 'a steady intake pipeline'

Avoid these words entirely unless quoting the prospect: 'visibility', 'below the fold', 'placement', 'listed', 'directory presence'. Replace with census/intake/beds/families/inquiries language.

When the prospect is hiring (hiring signal present), tie census directly to their expansion: new staff and new beds need to be filled, and that's the urgency.

INTELLIGENCE SIGNAL ANGLES (use one if relevant — these are gold):
- missing from competing directories → FOMO hook: 'Local family searches route entirely to your competitors right now.'
- actively hiring → expansion hook: 'Saw you're hiring [role] in [city] — perfect timing to keep that pipeline full.'
- big spender tech stack (HubSpot/Salesforce/CallRail/etc.) → fit hook: 'Since you already run [tool], our referral tags pipe directly in — zero new infra.'

HARD RULES:
1. ≥60% of body must reference THIS prospect specifically (facility name, city, owner, review count, specific signal, specific service).
2. NO generic openers ('Hope this finds you well', 'I came across your website').
3. STRUCTURE (this exact order):
   a. ONE specific genuine acknowledgment of something the center does well or a specific verifiable fact about them (a named program, a city expansion, hiring activity, review volume, accreditation, etc.).
   b. Immediately followed by a dead-simple value statement in plain language communicating that Sobriety Select connects families and patients actively searching for treatment with centers that have open beds. Phrase it in your own words, keep it concrete, do not copy a fixed line.
   c. The acknowledgment + value statement MUST land in the first 2 sentences, before the prospect decides whether to keep reading.
   d. ONE concrete census-framed observation about this prospect (their city, hiring signal, missing directory, etc.). Prioritize signal-based observations over generic pain points when available.
   e. ONE soft CTA with two concrete time options (see rule 6).
   Example of the opening pattern (adapt to the prospect, do not copy verbatim): "Tim, saw Aspire is bringing on 10 new clinical roles in Orlando. We connect families actively searching for a bed with centers that have them, and right now those Orlando searches are landing on your competitors."
4. Subject: max 6 words, lowercase, no questions, no spam hype.
5. Body: 80–110 words. One short paragraph or two micro-paragraphs.
6. End with ONE soft CTA that references something specific about this prospect, varied per email. Do not reuse a stock closing line.
   Examples of the pattern (do not copy verbatim, adapt to the prospect):
   - claimed: 'does this week or next work to get {facility} showing up in {city} searches?'
   - select: 'would Tuesday or Thursday work for a quick look at what families in {city} see when they search?'
   - premium: 'given you're backfilling those {N} roles, does Tuesday or Wednesday work for a brief census conversation?'
   The CTA must contain a prospect-specific token AND offer two concrete options.
7. Never claim outcomes data. Never reference PHI.
8. Banned words: revolutionary, game-changer, synergy, leverage, unlock, transform, cutting-edge, world-class.
9. NEVER mention price, tier cost, dollar amounts, or specific package names (Claimed/Select/Premium) in the email. Price is a conversation for the call, not the email. Anchoring price before the call gives the prospect a number to reject before they understand the value.
10. Never use em dashes (—). Never use hedging filler like 'Right now, though,' 'That said,' 'It's worth noting,' 'I wanted to reach out because.' Get to the point in the fewest words. Every sentence earns its place. Write like a sharp person talks, not like marketing copy.

PERSONALIZATION TECHNIQUE (this is what gets the email sent):
Before writing, identify the 3 MOST SPECIFIC facts about this exact prospect from the data provided. Specific facts are: their exact review count ('your 47 reviews'), a named service line ('your IOP program'), the owner's name, the specific city, a named missing directory ('you're not on Psychology Today'), a detected tool ('you're running CallRail'), or a hiring role ('your open intake coordinator role').
You MUST work at least 3 of these specific facts into the body. Generic statements about 'treatment centers' or 'directory visibility' or 'online presence' do NOT count — every sentence should be one a competitor could NOT send to a different center.
IF NO OWNER NAME: do not retreat to generic. Compensate by using MORE of the other specifics — lead with the exact review count or the missing-directory fact naming their city. Two concrete facts beat one name.
SELF-CHECK before output: reread your body. For each sentence ask 'could this be sent verbatim to a different treatment center?' If yes for more than one sentence, rewrite those sentences with prospect-specific detail.

Output ONLY valid JSON. No preamble, no markdown fences.
Schema: { "subject": string, "body": string, "specific_facts_used": string[] }`;

export const COLD_EMAIL_EVALUATOR_SYSTEM = `You are a strict cold-email QA reviewer. Score the email's prospect-specific personalization as a percentage of body content.

SPECIFIC = names, places, numbers, signals, or observations unique to THIS prospect (facility name, city, review count, owner name, specific service, hiring fact, competing-directory observation, tech-stack reference).
GENERIC = anything that could be sent to any treatment center.

A closing CTA counts as SPECIFIC if it references the prospect's facility, city, a signal, or a number. Only count a CTA as generic if it could be sent to any center verbatim (e.g. 'worth a quick call?').

Output ONLY valid JSON, no fences.
Schema: { "specific_sentences": string[], "generic_sentences": string[], "personalization_pct": number, "reasoning": string }`;

const PAIN_POINT_PRIORITY = [
  'no_outcomes_data',
  'no_reviews_mentioned',
  'weak_seo_title',
  'stock_photography_only',
  'thin_about_page',
  'no_team_photos',
  'no_schema_markup',
  'broken_or_no_https',
] as const;

// Cap operator reject reasons before injection. Sonia's hand-typed one-liners
// never approach this; the cap is purely defensive against a paste-bomb.
// ~240 chars ≈ 60 input tokens, so the marginal cost per re-draft stays
// negligible while the system prompt remains cached.
const REJECT_REASON_MAX_CHARS = 240;

const rankPainPoints = (painPoints: Prisma.JsonValue): string[] => {
  if (painPoints === null || typeof painPoints !== 'object' || Array.isArray(painPoints)) {
    return [];
  }
  return PAIN_POINT_PRIORITY.filter((k) => painPoints[k] === true);
};

const normalizeRejectReason = (reason: string | null | undefined): string | null => {
  if (reason === null || reason === undefined) return null;
  const trimmed = reason.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, REJECT_REASON_MAX_CHARS);
};

export const buildColdEmailUser = (
  lead: Lead,
  enrichment: Enrichment,
  previousRejectReason?: string | null,
): string => {
  const owner = enrichment.ownerName === null
    ? null
    : {
        name: enrichment.ownerName,
        title: enrichment.ownerTitle,
        linkedin: enrichment.ownerLinkedIn,
      };

  const context = {
    facility: lead.name,
    city: lead.city,
    state: lead.state,
    website: lead.website,
    googleRating: lead.googleRating,
    googleReviews: lead.googleReviews,
    services: lead.services,
    owner,
    teamSize: enrichment.teamSizeSignal,
    topPainPoints: rankPainPoints(enrichment.painPoints),
    signals: enrichment.signals,
    evidenceQuote: enrichment.evidenceQuote,
  };

  const base = `Prospect facts:\n${JSON.stringify(context, null, 2)}\n\nINTERNAL TIER (for tone/angle only — NEVER mention tier name, price, or any dollar amount in the email): ${enrichment.expectedProduct}\n\nWrite the email per the tier's angle. If any intelligence signal is high-leverage (missing from competing directories, active hiring, or big spender tech stack), prefer it as your lead observation.`;

  const reason = normalizeRejectReason(previousRejectReason);
  if (reason === null) return base;

  // Tail-only injection so the cached system prompt is unaffected. Reinforce
  // the absolute pricing rule in case the operator's reason itself echoes a
  // price or tier name (e.g. "killed it — you mentioned $9600").
  return `${base}\n\nOPERATOR FEEDBACK ON PREVIOUS REJECTED DRAFT for this prospect: "${reason}"\nAddress this critique directly in this rewrite. The absolute pricing rule and all other HARD RULES still apply — never mention price, dollar amounts, or tier names even if the operator's feedback contains them.`;
};
