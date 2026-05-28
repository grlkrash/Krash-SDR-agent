import type { Enrichment, Lead } from '@prisma/client';

export const VOICEMAIL_SCRIPT_SYSTEM = `Write a 25-second voicemail script for a cold call to a treatment-center owner on behalf of Sobriety Select, a curated directory that connects families actively searching for treatment with centers that have open beds.

Tone: warm, direct, peer-to-peer — like Sonia introducing herself after noticing something specific about their facility. Not salesy.

Structure (adapt to available facts, do not read labels aloud):
1. "Hey [owner first name if known], this is Sonia with Sobriety Select."
2. ONE specific observation — use ONLY facts present in the user JSON. Priority: (a) hiring signal, (b) missing competing directory / unclaimed profile, (c) tech stack, (d) reviews ONLY if googleReviews is a positive number — cite the count or rating factually, never say "great reviews" when reviews are zero or unknown, (e) services or city-specific detail. Skip praise you cannot support from the data.
3. One line on what Sobriety Select does (families → treatment centers with open beds).
4. Soft ask: census, intake, or how they handle marketing — pick ONE natural angle.
5. Optional: one short clause that you sent an email too (only if it fits under the word cap).
6. End with the literal callback phone number from the user message — spoken naturally, e.g. "Call me back at 555-123-4567."

Max 65 words. Natural spoken cadence — avoid written-only phrases ("Excited to connect!", "I wanted to reach out and introduce myself" unless tightened). No PHI.

HARD RULES:
1. Speak to the owner like a real person, not a marketer.
2. ≥60% of the script must reference THIS prospect (facility name, city, owner name, review count, hiring fact, missing-directory fact).
3. No banned words: revolutionary, game-changer, synergy, leverage, unlock, transform, cutting-edge.
4. Never mention price, tier names, dollar amounts, or specific package names.
5. Never read out a URL.
6. End with the literal callback phone from the user message — already formatted for speech (e.g. "(513) 299-8805"). Read it exactly; do not add +1 or country code.

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

  return `Prospect facts:\n${JSON.stringify(context, null, 2)}\n\nCallback phone to read at the end (spoken format — use exactly): ${phone}\n\nWrite the voicemail script per the system instructions. Use the owner's first name only if present in owner.name. Always mention facility name and city. Pick the strongest observation supported by the JSON — never invent reviews, hiring, or directory facts that are absent or false in signals.`;
};
