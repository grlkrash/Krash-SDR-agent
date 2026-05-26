// Renewal warning drafter prompt. Triggered ~60d before a closed-won deal's
// ss_renewal_date. Tone is confident CSM, not anxious — Sonia signs off on
// the renewal conversation already in motion.
//
// Prompt 9.2.1 corrections to the initial draft:
//   - No price. The first cut leaked the dollar figure into the body, which
//     reframed the renewal around cost. Price belongs on the call, attached
//     to results.
//   - No raw {placeholder} tokens. The first cut used {positive_metric_placeholder},
//     which renders as literal braces and ships by accident if Sonia
//     approves without filling it in. The new contract: read cleanly with
//     zero fill-ins, or use an unambiguously-bracketed [OPTIONAL: ...] note
//     Sonia can paste a real win into.
//
// `tier` and `tierPrice` remain in buildRenewalUser's signature for caller-
// site stability and AuditLog observability (outreach/renewalWarning still
// writes tierPrice into the drafted audit row), but they are NOT rendered
// into the user prompt — the model must never see the price.

import type { Enrichment, Lead } from '@prisma/client';

export const RENEWAL_WARNING_SYSTEM = `Write a 60-day pre-renewal email to a Sobriety Select client. Tone: confident, not anxious — a partner confirming the next year together, not a salesperson worried about losing them.

The email MUST:
- Reference the renewal_date from user context as a calendar anchor.
- Warmly reference the ongoing partnership and the specific facility name + city.
- Express genuine interest in continuing.
- End with two specific call times for them to choose between to confirm and discuss the year ahead.

The email MUST NOT:
- Mention price, dollar figures, or any cost. Price comes up on the call, attached to results.
- Name the tier (e.g., "claimed", "select", "premium", "Select Listing"). "Sobriety Select" as the brand name is fine.
- Include any {variable} or {placeholder} tokens — those render raw and ship by accident.

If a specific positive metric would genuinely land, include it as an obviously-bracketed optional fill-in for Sonia, formatted exactly: [OPTIONAL: add a specific win, e.g. "you've had 14 new inquiries this quarter"]. Otherwise omit the metric entirely — the body must read cleanly with zero fill-ins required.

70-80 words for the body (the optional bracket, if used, does not count toward the word budget).

Output JSON: { "subject": string, "body": string }`;

type DealFacts = {
  name: string;
  productType: string | null;
};

type LeadFacts = Pick<Lead, 'name' | 'city' | 'state' | 'services'>;

type EnrichmentFacts = Pick<
  Enrichment,
  'ownerName' | 'ownerTitle' | 'expectedProduct'
>;

const formatRenewalDate = (d: Date): string =>
  d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

export const buildRenewalUser = (
  deal: DealFacts,
  lead: LeadFacts,
  enrichment: EnrichmentFacts,
  renewalDate: Date,
  _tier: string,
  _tierPrice: number,
): string => {
  const lines: string[] = [
    `facility: ${lead.name}`,
    `city: ${lead.city}`,
    `state: ${lead.state}`,
    `deal_name: ${deal.name}`,
    `renewal_date: ${formatRenewalDate(renewalDate)}`,
  ];
  if (lead.services.length > 0) {
    lines.push(`services: ${lead.services.join(', ')}`);
  }
  if (enrichment.ownerName !== null) {
    lines.push(`owner: ${enrichment.ownerName}`);
  }
  if (enrichment.ownerTitle !== null) {
    lines.push(`owner_title: ${enrichment.ownerTitle}`);
  }
  return lines.join('\n');
};
