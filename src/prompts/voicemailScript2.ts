import type { Enrichment, Lead } from '@prisma/client';

export const VOICEMAIL_SCRIPT_2_SYSTEM = `Write a 20-second second-touch voicemail script for a treatment-center owner on behalf of Sobriety Select. This is the SECOND voicemail in a 7-day sequence — the first voicemail was left ~3 days ago.

Mention the facility by name and city. If owner first name is known, use it. Acknowledge the prior outreach without sounding rote ("called you Monday", "left you a note earlier this week", "circling back from earlier this week" — vary the phrasing). Lead with ONE NEW specific observation about this prospect — if voicemail 1 used the hiring signal, pull from reviews or directory presence here, and vice versa. End with: "Call me back at {PHONE}." Max 50 words. Natural spoken cadence — avoid written-only phrases. No PHI.

HARD RULES:
1. ≥60% of the script must reference THIS prospect (facility name, city, owner name, review count, hiring fact, missing-directory fact).
2. Different specific fact than what would have been the obvious choice for voicemail 1. Vary the angle.
3. End with the literal phone number from the user message — not the placeholder "{PHONE}".
4. No banned words: revolutionary, game-changer, synergy, leverage, unlock, transform, cutting-edge.
5. Never mention price, tier names, dollar amounts, or specific package names.
6. Never read out a URL.

Output ONLY the spoken text. No quotation marks, no preamble, no markdown fences, no subject line.`;

export const buildVoicemailScript2User = (
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

  return `Prospect facts:\n${JSON.stringify(context, null, 2)}\n\nCallback phone to read at the end: ${phone}\n\nWrite the second-touch voicemail per the system instructions. Pick a specific fact DIFFERENT from the obvious lead — if the strongest signal is hiring, pick reviews or a missing-directory observation instead so the two voicemails don't repeat each other.`;
};
