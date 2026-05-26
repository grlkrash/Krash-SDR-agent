// Discovery-call prep brief prompt (Prompt 9.4).
//
// Sonia opens /prep-brief/:dealId 5 minutes before a discovery call. The
// markdown is rendered inline (and optionally emailed). The brief MUST
// read like Sonia studied this prospect for hours — concrete facts only.
//
// The `${commission}` token in the system prompt is a literal placeholder
// the MODEL emits (e.g. "$240 commission") — NOT a TS template binding,
// hence the `\${...}` escapes in the template literal below.
//
// `any` is forbidden in this codebase (`.cursorrules`), so the
// `hubspotEngagements: any[]` / `hubspotDeal: any` shape the spec sketches
// is realized via the typed `PrepBriefEngagement` / `PrepBriefDeal`
// structs below. The outreach module builds them after the HubSpot fetch.

import type { Enrichment, Lead } from '@prisma/client';

export const PREP_BRIEF_SYSTEM = `You generate a 5-minute pre-call brief for a B2B SDR (Sonia) at Sobriety Select. The brief must be markdown, scannable in under 60 seconds, and packed with specific facts that make Sonia sound like she's been studying this prospect for hours.

STRUCTURE (use these exact headers):
## One-line summary
{facility}, {bed-count if known}, {city state}, owner {name if known}. Expected tier: {tier} (\${commission} commission).

## 🎯 Three sharpest data points
Three bullet items. Prefer signal-based (hiring spike, missing from competing directories, big-spender tech stack) over generic pain points.

## ⚠️ Pain points
Top 3 from the painPoints JSON. One bullet each, ≤ 12 words.

## 📜 Conversation history
1-line summary of last 3 HubSpot engagements (oldest first → newest). If none, say 'No prior contact'.

## ❓ The 3 questions to ask
Specific, open-ended questions based on context. Not generic ('how's business?'). Examples: 'How many of your beds are private-pay vs Medicaid?' 'Your IOP page has no schema markup — is that intentional or a gap?'

## 🛑 Known objections to expect
2-3 likely objections based on the tier they fit. For Select: 'we tried directories before'. For Premium: 'we already spend on Google Ads'. For Claimed: 'is this just SEO bait?'.

## 🎯 The angle to lead with
ONE sentence Sonia uses as her opener. Specific. Drawn from the sharpest data point.

## 💵 Pricing reminder
Exact tier + annual price + Sonia's commission. From PRD pricing table.

Output ONLY the markdown — no preamble.`;

// Annual list prices from PRD §5 pricing table. Surface them in the user
// prompt so the 💵 Pricing reminder section is grounded in concrete numbers
// rather than the model's training-time guess.
const TIER_ANNUAL_PRICE: Record<string, number> = {
  claimed: 600,
  select: 2400,
  premium: 9600,
  seo: 18000,
  social: 12000,
  ppc: 18000,
  'upsell-bundle': 25000,
};

const ENGAGEMENT_BODY_MAX = 240;

export type PrepBriefContact = {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  jobTitle: string | null;
};

export type PrepBriefDeal = {
  dealname: string | null;
  dealstage: string | null;
  amount: string | null;
  productType: string | null;
  closedate: string | null;
  companyName: string | null;
  companyDomain: string | null;
  contacts: PrepBriefContact[];
};

export type PrepBriefEngagement = {
  kind: 'note' | 'email' | 'call' | 'meeting' | 'task';
  subject: string | null;
  body: string | null;
  // ISO-8601 string — keeps the user prompt deterministic regardless of the
  // runner's timezone, and Claude has no trouble parsing them.
  timestamp: string;
};

const collapseAndTrim = (raw: string | null, max: number): string | null => {
  if (raw === null) return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
};

export const buildPrepBriefUser = (
  lead: Lead,
  enrichment: Enrichment,
  hubspotEngagements: PrepBriefEngagement[],
  hubspotDeal: PrepBriefDeal,
  commission: number,
): string => {
  const tierRaw = hubspotDeal.productType ?? enrichment.expectedProduct ?? null;
  const tier = tierRaw === null || tierRaw === '' ? 'unknown' : tierRaw;
  const annualPrice = TIER_ANNUAL_PRICE[tier] ?? null;

  const context = {
    facility: {
      name: lead.name,
      city: lead.city,
      state: lead.state,
      website: lead.website,
      phoneE164: lead.phoneE164,
      services: lead.services,
      googleRating: lead.googleRating,
      googleReviews: lead.googleReviews,
    },
    owner: {
      name: enrichment.ownerName,
      title: enrichment.ownerTitle,
      email: enrichment.ownerEmail,
      linkedin: enrichment.ownerLinkedIn,
    },
    tier,
    commission,
    annualPrice,
    teamSize: enrichment.teamSizeSignal,
    painPoints: enrichment.painPoints,
    signals: enrichment.signals,
    evidenceQuote: enrichment.evidenceQuote,
    legitscriptStatus: enrichment.legitscriptStatus,
    deal: {
      name: hubspotDeal.dealname,
      stage: hubspotDeal.dealstage,
      amount: hubspotDeal.amount,
      productType: hubspotDeal.productType,
      closeDate: hubspotDeal.closedate,
    },
    company: {
      hubspotName: hubspotDeal.companyName,
      domain: hubspotDeal.companyDomain,
    },
    contacts: hubspotDeal.contacts,
    recentEngagements: hubspotEngagements.map((e) => ({
      kind: e.kind,
      subject: e.subject,
      body: collapseAndTrim(e.body, ENGAGEMENT_BODY_MAX),
      timestamp: e.timestamp,
    })),
  };

  const priceLine = annualPrice === null
    ? 'annual price is unknown — write "(annual price unknown)" in the pricing reminder'
    : `annual price is $${annualPrice.toLocaleString('en-US')}`;

  return [
    'Generate the 5-minute pre-call prep brief in markdown for the prospect below.',
    '',
    'CONTEXT (JSON):',
    JSON.stringify(context, null, 2),
    '',
    `Use commission=$${commission} and tier="${tier}" (${priceLine}) when filling the One-line summary and the 💵 Pricing reminder.`,
    '',
    'If bed-count is not in the data, write "(bed count unknown)" in the One-line summary — never invent a number.',
    'If owner.name is null, omit the "owner ..." clause from the One-line summary rather than fabricating one.',
    'For 📜 Conversation history: render the 3 most recent recentEngagements (or all of them if fewer than 3) in chronological order (oldest first → newest). If recentEngagements is empty, write exactly "No prior contact".',
    'Three sharpest data points MUST prefer signal-based observations from signals.hiring / signals.competingDirectories / signals.techStack when present, before falling back to painPoints.',
  ].join('\n');
};
