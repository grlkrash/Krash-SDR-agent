// Quarterly check-in drafter prompt. Triggered ~90/180/270d after a deal
// closed-won. Tone is post-sale CSM, not SDR: warmth + service, no pitch.
// `Q{N}` in the soft-offer line resolves to the current calendar quarter
// passed in via the user prompt's `calendar_quarter` field — NOT to the
// customer's tenure. See INSTRUCTIONS Prompt 9.1.1 for the fix history.

import type { Enrichment, Lead } from '@prisma/client';

export const QUARTERLY_CHECKIN_SYSTEM = `Write a short, warm, no-pitch quarterly check-in to a Sobriety Select client. Reference how long they've been with us. Ask ONE specific question about their listing performance or facility's current census. End with a soft offer 'want me to pull your Q{N} listing analytics?' where N is the calendar_quarter integer from user context (1-4) — never customer tenure. 70 words max. No sales pitch — just warmth and service.

Output JSON: { "subject": string, "body": string }`;

type DealFacts = {
  name: string;
  closeDate: Date;
  productType: string | null;
};

type LeadFacts = Pick<Lead, 'name' | 'city' | 'state' | 'services'>;

type EnrichmentFacts = Pick<
  Enrichment,
  'ownerName' | 'ownerTitle' | 'expectedProduct'
>;

const MONTHS_PER_QUARTER = 3;
const DAYS_PER_MONTH = 30;

const currentQuarter = (now: Date): number =>
  Math.floor(now.getMonth() / MONTHS_PER_QUARTER) + 1;

const formatRetention = (daysSinceClose: number): string => {
  const months = Math.max(1, Math.round(daysSinceClose / DAYS_PER_MONTH));
  if (months < MONTHS_PER_QUARTER) return `${months} month${months === 1 ? '' : 's'}`;
  const quarters = Math.round(months / MONTHS_PER_QUARTER);
  return `${quarters} quarter${quarters === 1 ? '' : 's'} (~${months} months)`;
};

export const buildQuarterlyUser = (
  deal: DealFacts,
  lead: LeadFacts,
  enrichment: EnrichmentFacts,
  daysSinceClose: number,
): string => {
  const quarter = currentQuarter(new Date());
  const lines: string[] = [
    `facility: ${lead.name}`,
    `city: ${lead.city}`,
    `state: ${lead.state}`,
    `deal_name: ${deal.name}`,
    `tier: ${deal.productType ?? enrichment.expectedProduct ?? 'unknown'}`,
    `retained_for: ${formatRetention(daysSinceClose)}`,
    `days_since_close: ${daysSinceClose}`,
    `calendar_quarter: ${quarter}`,
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
