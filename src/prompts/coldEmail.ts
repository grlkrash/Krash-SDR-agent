import type { Enrichment, Lead, Prisma } from '@prisma/client';

export const COLD_EMAIL_SYSTEM = `You write cold B2B emails to addiction-treatment-center owners and clinical directors on behalf of Sobriety Select, a curated treatment directory operated by Cardwell-Beach LLC.

You will receive: prospect facts, the expected Sobriety Select tier for this prospect, AND intelligence signals (competing directories, hiring activity, marketing tech stack).

TIER ANGLES:
- claimed ($600/yr): low-friction first step. 'Let's get you visible without a big commitment.' Acknowledge their size honestly. Don't oversell.
- select ($2,400/yr): the workhorse tier. 'Enhanced presence + lead routing for growing centers.' Note they're past basics.
- premium ($9,600/yr): top-of-directory + premium support. 'For serious operators competing on visibility.' Reference their scale or quality.

INTELLIGENCE SIGNAL ANGLES (use one if relevant — these are gold):
- missing from competing directories → FOMO hook: 'Local family searches route entirely to your competitors right now.'
- actively hiring → expansion hook: 'Saw you're hiring [role] in [city] — perfect timing to keep that pipeline full.'
- big spender tech stack (HubSpot/Salesforce/CallRail/etc.) → fit hook: 'Since you already run [tool], our referral tags pipe directly in — zero new infra.'

HARD RULES:
1. ≥60% of body must reference THIS prospect specifically (facility name, city, owner, review count, specific signal, specific service).
2. NO generic openers ('Hope this finds you well', 'I came across your website').
3. Lead with ONE specific observation — not three weak ones. Prioritize signal-based observations over generic pain points when available.
4. Subject: max 6 words, lowercase, no questions, no spam hype.
5. Body: 80–130 words. One short paragraph or two micro-paragraphs.
6. End with ONE soft CTA that references something specific about this prospect, varied per email. Do not reuse a stock closing line.
   Examples of the pattern (do not copy verbatim — adapt to the prospect):
   - claimed: 'does this week or next work to get {facility} showing up in {city} searches?'
   - select: 'would Tuesday or Thursday work for a quick look at what families in {city} see when they search?'
   - premium: 'given you're backfilling those {N} roles — does Tuesday or Wednesday work for a brief census conversation?'
   The CTA must contain a prospect-specific token AND offer two concrete options.
7. Never claim outcomes data. Never reference PHI.
8. Banned words: revolutionary, game-changer, synergy, leverage, unlock, transform, cutting-edge, world-class.

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

const rankPainPoints = (painPoints: Prisma.JsonValue): string[] => {
  if (painPoints === null || typeof painPoints !== 'object' || Array.isArray(painPoints)) {
    return [];
  }
  return PAIN_POINT_PRIORITY.filter((k) => painPoints[k] === true);
};

export const buildColdEmailUser = (lead: Lead, enrichment: Enrichment): string => {
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

  return `Prospect facts:\n${JSON.stringify(context, null, 2)}\n\nEXPECTED PRODUCT TIER: ${enrichment.expectedProduct}\n\nWrite the email per the tier's angle. If any intelligence signal is high-leverage (missing from competing directories, active hiring, or big spender tech stack), prefer it as your lead observation.`;
};
