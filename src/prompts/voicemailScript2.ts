import type { Enrichment, Lead } from '@prisma/client';
import type { VoicemailTrigger } from '../shared/voicemailCompliance.js';

export const VOICEMAIL_SCRIPT_2_SYSTEM = `Write the PERSONALIZED MIDDLE of a second-touch voicemail for an EXISTING Sobriety Select client or warm account. Touch 1 was left ~3 business days ago on the same renewal or reactivation thread.

IMPORTANT: Legal disclosures are added by code. Do NOT include them. Do NOT impersonate a live caller.

Mention facility by name and city. Acknowledge the prior voicemail briefly. Lead with ONE NEW observation from the JSON. End with callback phone. Max 35 words. Warm CSM tone — not cold outreach.

HARD RULES:
1. Never identify as Sonia speaking live.
2. ≥60% must reference THIS prospect.
3. Vary the angle from what touch 1 likely covered.
4. End with literal callback phone — read exactly.
5. No banned words, prices, tier names, or URLs.

Output ONLY the personalized middle text.`;

export const buildVoicemailScript2User = (
  lead: Lead,
  enrichment: Enrichment,
  phone: string,
  trigger: VoicemailTrigger,
): string => {
  const owner = enrichment.ownerName === null
    ? null
    : { name: enrichment.ownerName, title: enrichment.ownerTitle };

  const context = {
    trigger,
    facility: lead.name,
    city: lead.city,
    state: lead.state,
    googleRating: lead.googleRating,
    googleReviews: lead.googleReviews,
    services: lead.services,
    owner,
    signals: enrichment.signals,
    evidenceQuote: enrichment.evidenceQuote,
  };

  return `Prospect facts:\n${JSON.stringify(context, null, 2)}\n\nCallback phone (use exactly): ${phone}\n\nWrite ONLY the personalized middle for touch 2. Trigger: "${trigger}". Disclosures added automatically.`;
};
