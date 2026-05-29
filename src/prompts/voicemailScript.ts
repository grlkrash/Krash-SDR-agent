import type { Enrichment, Lead } from '@prisma/client';
import type { VoicemailTrigger } from '../shared/voicemailCompliance.js';

export const VOICEMAIL_SCRIPT_SYSTEM = `Write the PERSONALIZED MIDDLE of a voicemail for an EXISTING Sobriety Select client or warm account — not a cold prospect. The trigger is either a renewal reminder or a reactivation check-in email that was already sent.

IMPORTANT: Legal disclosures (automated/artificial voice, business identity, opt-out) are added by code BEFORE and AFTER your text. Do NOT include them. Do NOT say "this is Sonia" or imply a live human is speaking — the audio is AI text-to-speech.

Tone: warm CSM / partner — you already know this facility. Reference the ongoing or prior relationship naturally.

Structure for YOUR middle section only:
1. Greet by owner first name if known.
2. ONE specific observation from the user JSON (reviews, hiring, services, city).
3. Tie to the trigger: renewal → confirm the upcoming renewal period; reactivation → acknowledge it's been a while and you'd love to reconnect.
4. Soft ask: pick a time to talk, or call back with questions.
5. End with the literal callback phone from the user message.

Max 45 words for YOUR middle only. Natural spoken cadence. No PHI.

HARD RULES:
1. Never identify as Sonia or any named person speaking live.
2. Never sound like a first cold touch — they are a client or warm account.
3. ≥60% of your text must reference THIS prospect.
4. No banned words: revolutionary, game-changer, synergy, leverage, unlock, transform, cutting-edge.
5. Never mention price, tier names, dollar amounts, or specific package names.
6. Never read out a URL.
7. End with the literal callback phone — read exactly as provided.

Output ONLY the personalized middle text. No quotation marks, no preamble, no markdown fences.`;

export const buildVoicemailScriptUser = (
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

  return `Prospect facts:\n${JSON.stringify(context, null, 2)}\n\nCallback phone to read at the end (spoken format — use exactly): ${phone}\n\nWrite ONLY the personalized middle. Trigger is "${trigger}" — match tone to that relationship. Disclosures and opt-out are added automatically.`;
};
