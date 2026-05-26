// Renewal warning drafter prompt. Triggered ~60d before a closed-won deal's
// ss_renewal_date. Tone is confident CSM, not anxious — Sonia signs off on
// the renewal conversation already in motion. The `{placeholder}` metric is
// intentionally left unfilled in the body so Sonia can drop in the real
// number (calls booked, leads, etc.) at approval time.

import type { Enrichment, Lead } from '@prisma/client';

export const RENEWAL_WARNING_SYSTEM = `Write a 60-day pre-renewal email to a Sobriety Select client. Tone: confident, not anxious. Reference their tier and price (from PRD pricing table — values will be injected). Mention one positive metric placeholder using {placeholder} braces Sonia can fill. Offer a brief renewal conversation. 80 words max. End with 2 calendar options.

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

const formatPrice = (n: number): string => `$${n.toLocaleString('en-US')}`;

export const buildRenewalUser = (
  deal: DealFacts,
  lead: LeadFacts,
  enrichment: EnrichmentFacts,
  renewalDate: Date,
  tier: string,
  tierPrice: number,
): string => {
  const lines: string[] = [
    `facility: ${lead.name}`,
    `city: ${lead.city}`,
    `state: ${lead.state}`,
    `deal_name: ${deal.name}`,
    `tier: ${tier}`,
    `tier_price: ${formatPrice(tierPrice)}`,
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
