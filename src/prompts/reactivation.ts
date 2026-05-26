// Reactivation drafter prompt. Triggered for open deals that have gone
// stale (hs_lastmodifieddate >30d) but still have a prior reply or
// follow-up touch in their Draft history — i.e. a relationship that
// went quiet, not a contact that was never warm.
//
// Unlike the renewal/quarterly prompts, this one DELIBERATELY keeps
// `{placeholder}` braces in the rendered body: the opening "fresh angle"
// (industry stat, new feature, case study) is Sonia's pick — the model's
// job is to wire the scaffold, not invent specifics it can't ground in
// the user context. Sonia fills the brace in /queue before approving.
//
// `{daysSinceContact}` in the system prompt is a token the model
// substitutes from the `daysSinceContact: <N>` line in the user prompt.

import type { Enrichment, Lead } from '@prisma/client';

export const REACTIVATION_SYSTEM = `Write a reactivation email to a treatment-center prospect we last spoke with ~{daysSinceContact} days ago. Open with a fresh angle: a recent industry observation, a new Sobriety Select feature, or a relevant case study (use {placeholder} braces). 80 words max. End with a clear 15-min ask.

Output JSON: { "subject": string, "body": string }`;

type DealFacts = {
  name: string;
};

type LeadFacts = Pick<Lead, 'name' | 'city' | 'state' | 'services'>;

type EnrichmentFacts = Pick<
  Enrichment,
  'ownerName' | 'ownerTitle' | 'expectedProduct'
>;

export const buildReactivationUser = (
  deal: DealFacts,
  lead: LeadFacts,
  enrichment: EnrichmentFacts,
  daysSinceContact: number,
): string => {
  const lines: string[] = [
    `facility: ${lead.name}`,
    `city: ${lead.city}`,
    `state: ${lead.state}`,
    `deal_name: ${deal.name}`,
    `daysSinceContact: ${daysSinceContact}`,
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
  // internal_tier informs tone only — system prompt forbids naming the tier
  // directly. Mirrors the convention used in coldEmail/replied prompts.
  if (enrichment.expectedProduct !== null) {
    lines.push(`internal_tier: ${enrichment.expectedProduct}`);
  }
  return lines.join('\n');
};
