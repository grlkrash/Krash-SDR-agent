// Discovery-call prep brief prompt (Prompt 9.4).
//
// Sonia opens /prep-brief/lead/:leadId (or /prep-brief/:dealId) before a call.
// The markdown is rendered inline (and optionally emailed). Lead + enrichment
// data is the source of truth; HubSpot deal/engagement data supplements when present.

import type { Enrichment, Lead } from '@prisma/client';

export const PREP_BRIEF_SYSTEM = `You generate a 5-minute pre-call brief for a B2B SDR (Sonia) at Sobriety Select. The brief must be markdown, scannable in under 60 seconds, and packed with specific facts that make Sonia sound like she's been studying this prospect for hours.

STRUCTURE (use these exact headers in this order):
## 📍 Facility snapshot
Bird's-eye view of what we know: full location (street/city/state/zip when present), services offered, inferred facility type from services + teamSizeSignal (e.g. "IOP + sober living, small team"), Google rating/review count, phone, website. Bed count only if in data — otherwise "(bed count unknown)". One tight paragraph or 4–6 bullets.

## 🌐 Web presence & site analysis
Website scan findings: list ONLY pain_points keys that are true (human-readable labels), legitscript status, competing-directory signal (listed vs missing from Psychology Today / Rehabs.com / Recovery.com), hiring signal if active, marketing tech stack tools detected. Evidence quote if present. This section is the site/intelligence read — no pitch yet.

## One-line summary
{facility}, {bed-count if known}, {city state}, owner {name if known}. Expected tier: {tier} (\${commission} commission).

## 🎯 Three sharpest data points
Three bullet items. Prefer signal-based (hiring spike, missing from competing directories, big-spender tech stack) over generic pain points.

## ⚠️ Pain points
Top 3 from the painPoints JSON. One bullet each, ≤ 12 words.

## 📜 Conversation history
1-line summary of last 3 HubSpot engagements (oldest first → newest). If none, summarize outreachHistory (our sent emails/VM) if present. If both empty, say 'No prior contact'.

## ❓ The 3 questions to ask
Specific, open-ended questions based on context. Not generic ('how's business?'). Examples: 'How many of your beds are private-pay vs Medicaid?' 'Your IOP page has no schema markup — is that intentional or a gap?'

## 🛑 Known objections to expect
2-3 likely objections based on the tier they fit. For Select: 'we tried directories before'. For Premium: 'we already spend on Google Ads'. For Claimed: 'is this just SEO bait?'. When freeListingOffered is true, ALWAYS include the free-vs-paid objection — 'why pay when the basic profile is free?' — with a one-line grounded rebuttal (the free profile just gets them on the map; the paid tier adds tier-specific reach/lead capture).

## 💎 Free listing → premium pivot
Only include this section when freeListingOffered is true (they entered through the free-profile offer). Give Sonia exactly two bullets: (1) the easy win — confirm/claim the free basic profile live on the call; (2) the specific incremental value of THIS prospect's expected tier OVER the free listing, grounded in a real signal/pain point above (e.g. Select: priority regional placement + lead capture; Premium: top placement + insurance-match routing + verified reviews). Stay honest: frame the upgrade as more aligned, qualified inquiries — NEVER guaranteed admissions, "fill your beds", or any outcome promise, and never imply the prospect is currently invisible. If freeListingOffered is false, omit this section entirely.

## 🎯 The angle to lead with
ONE sentence Sonia uses as her opener. Specific. Drawn from the sharpest data point.

## 💵 Pricing reminder
Exact tier + annual price + Sonia's commission. From PRD pricing table.

Output ONLY the markdown — no preamble.`;

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

const PAIN_POINT_LABELS: Record<string, string> = {
  thin_about_page: 'Thin about page',
  no_team_photos: 'No team photos on site',
  stock_photography_only: 'Stock photography only',
  no_outcomes_data: 'No outcomes/data published',
  broken_or_no_https: 'Broken site or no HTTPS',
  no_schema_markup: 'No schema markup',
  no_reviews_mentioned: 'No reviews mentioned on site',
  weak_seo_title: 'Weak SEO title tags',
  no_website: 'No website on file',
  broken_or_slow: 'Website broken or slow to load',
};

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
  timestamp: string;
};

export type PrepBriefOutreachTouch = {
  kind: string;
  subject: string | null;
  sentAt: string;
};

const collapseAndTrim = (raw: string | null, max: number): string | null => {
  if (raw === null) return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return null;
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
};

const summarizePainPoints = (painPoints: unknown): string[] => {
  if (typeof painPoints !== 'object' || painPoints === null || Array.isArray(painPoints)) {
    return [];
  }
  const entries = Object.entries(painPoints as Record<string, unknown>);
  return entries
    .filter(([, v]) => v === true)
    .map(([key]) => PAIN_POINT_LABELS[key] ?? key.replace(/_/g, ' '));
};

const inferFacilityType = (
  services: string[],
  teamSizeSignal: string | null,
): string => {
  const parts: string[] = [];
  if (services.length > 0) parts.push(services.slice(0, 5).join(', '));
  if (teamSizeSignal !== null && teamSizeSignal !== '' && teamSizeSignal !== 'unknown') {
    parts.push(`${teamSizeSignal} team`);
  }
  return parts.length === 0 ? 'unknown' : parts.join(' · ');
};

export const buildPrepBriefUser = (
  lead: Lead,
  enrichment: Enrichment,
  hubspotEngagements: PrepBriefEngagement[],
  hubspotDeal: PrepBriefDeal,
  commission: number,
  freeListingOffered: boolean = false,
  outreachHistory: PrepBriefOutreachTouch[] = [],
): string => {
  const tierRaw = hubspotDeal.productType ?? enrichment.expectedProduct ?? null;
  const tier = tierRaw === null || tierRaw === '' ? 'unknown' : tierRaw;
  const annualPrice = TIER_ANNUAL_PRICE[tier] ?? null;
  const sitePainPoints = summarizePainPoints(enrichment.painPoints);

  const context = {
    facility: {
      name: lead.name,
      street: lead.street,
      city: lead.city,
      state: lead.state,
      zip: lead.zip,
      facilityType: inferFacilityType(lead.services, enrichment.teamSizeSignal),
      services: lead.services,
      website: lead.website,
      phoneE164: lead.phoneE164,
      googleRating: lead.googleRating,
      googleReviews: lead.googleReviews,
      source: lead.source,
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
    freeListingOffered,
    teamSize: enrichment.teamSizeSignal,
    painPoints: enrichment.painPoints,
    sitePainPoints,
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
    outreachHistory,
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
    '## 📍 Facility snapshot must include location, services, and facilityType from the JSON — this is the bird\'s-eye data view Sonia scans first.',
    '## 🌐 Web presence & site analysis must translate sitePainPoints, signals, and legitscriptStatus into plain English — no invented findings.',
    'If bed-count is not in the data, write "(bed count unknown)" in the One-line summary — never invent a number.',
    'If owner.name is null, omit the "owner ..." clause from the One-line summary rather than fabricating one.',
    'For 📜 Conversation history: prefer recentEngagements (HubSpot); if empty, use outreachHistory; if both empty write exactly "No prior contact".',
    'Three sharpest data points MUST prefer signal-based observations from signals.hiring / signals.competingDirectories / signals.techStack when present, before falling back to painPoints.',
    freeListingOffered
      ? 'freeListingOffered is true: include the "💎 Free listing → premium pivot" section and the free-vs-paid objection. The prospect was offered the free Sobriety Select profile in cold outreach — confirm/claim it as the easy win, then pivot to the paid tier value. Honest framing only — no outcome guarantees.'
      : 'freeListingOffered is false: OMIT the "💎 Free listing → premium pivot" section entirely.',
  ].join('\n');
};
