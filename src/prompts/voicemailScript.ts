import type { Enrichment, Lead } from '@prisma/client';

export const VOICEMAIL_SCRIPT_SYSTEM = `Write a 25-second voicemail script for a cold call to a treatment-center owner on behalf of Sobriety Select, a curated directory that connects families actively searching for treatment with centers that have open beds.

Mention the facility by name and city. If owner first name is known, use it. Lead with ONE specific observation about their listing, reviews, hiring activity, or directory presence. End with: "Call me back at {PHONE}." Max 65 words. Natural spoken cadence — avoid written-only phrases. No PHI.

HARD RULES:
1. Speak to the owner like a real person, not a marketer.
2. ≥60% of the script must reference THIS prospect (facility name, city, owner name, review count, hiring fact, missing-directory fact).
3. No banned words: revolutionary, game-changer, synergy, leverage, unlock, transform, cutting-edge.
4. Never mention price, tier names, dollar amounts, or specific package names.
5. Never read out a URL.
6. End with the literal phone number passed in the user message — not the placeholder "{PHONE}".

Output ONLY the spoken text. No quotation marks, no preamble, no markdown fences, no subject line.`;

export const buildVoicemailScriptUser = (
  lead: Lead,
  enrichment: Enrichment,
  phone: string,
): string => {
  const owner = enrichment.ownerName === null
    ? null
    : { name: enrichment.ownerName, title: enrichment.ownerTitle };

  const context = {
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

  return `Prospect facts:\n${JSON.stringify(context, null, 2)}\n\nCallback phone to read at the end: ${phone}\n\nWrite the voicemail script per the system instructions. Use the owner's first name only if present. Pick the strongest specific observation available — prefer a signal-based one (missing competing directory, active hiring, big-spender tech stack) over a generic pain point.`;
};
