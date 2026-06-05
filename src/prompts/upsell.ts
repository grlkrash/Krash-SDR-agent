// Upsell drafter prompt. Triggered when a closed-won Sobriety Select customer
// surfaces a NEW growth signal (hiring, missing competing-directory presence,
// or a big-spender tech stack). Tone is warm CSM + congratulation, not SDR
// pitch — one upsell angle, one soft ask, no price, no tier names.
//
// `signalSummary` is derived by the caller (draftUpsellBatch.ts) so the
// prompt builder stays a pure string-shaper — the same pattern as
// buildNudgeUser/buildRenewalUser. The signal one-liner is also persisted
// to Draft.specificFacts so /queue surfaces it without re-parsing.

import type { Enrichment, Lead } from '@prisma/client';
import { DRAFT_VOICE_RULES } from './draftVoice.js';

export const UPSELL_SYSTEM = `Write a short, warm congratulation + upsell hook to a Sobriety Select customer who has shown a NEW growth signal (hiring, expansion, missing from competing directories, expanded tech stack). Open with a specific congratulation tied to the signal. Pivot to ONE upsell angle that fits: SEO if missing from directories, PPC/Premium if scaling, account expansion if hiring intake. End with a soft ask ('want 10 min to talk about scaling this listing alongside your growth?'). 70 words max. No price, no tier names, no fluff.

${DRAFT_VOICE_RULES}

Output ONLY valid JSON. No preamble, no markdown fences. Schema: { "subject": string, "body": string }`;

type LeadFacts = Pick<Lead, 'name' | 'city' | 'state' | 'services'>;

type EnrichmentFacts = Pick<
  Enrichment,
  'ownerName' | 'ownerTitle' | 'expectedProduct'
>;

export const buildUpsellUser = (
  lead: LeadFacts,
  enrichment: EnrichmentFacts,
  signalSummary: string,
): string => {
  const lines: string[] = [
    `facility: ${lead.name}`,
    `city: ${lead.city}`,
    `state: ${lead.state}`,
    `growth_signal: ${signalSummary}`,
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
  if (enrichment.expectedProduct !== null) {
    lines.push(`current_tier: ${enrichment.expectedProduct}`);
  }
  return lines.join('\n');
};
