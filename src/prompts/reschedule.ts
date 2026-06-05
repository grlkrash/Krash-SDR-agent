// Reschedule drafter prompt. For a booked discovery call that has come and
// gone — typically a no-show, but the copy works as a soft re-book for any
// passed meeting where the prospect went quiet. Voicemail is paused, so the
// follow-up surfaces in the daily brief and Sonia drafts a reschedule here.
//
// Tone is the opposite of guilt-trip: assume good faith ("things get busy"),
// keep it short, and make re-booking frictionless. The free-listing entry
// offer stays the reason-to-talk; the booking link is the ask.

import type { Enrichment, Lead } from '@prisma/client';
import { DRAFT_VOICE_RULES } from './draftVoice.js';

export const RESCHEDULE_SYSTEM = `Write a short, warm email to a treatment-center prospect who booked a quick call with Sobriety Select that did not happen (~{daysSinceMeeting} days ago). Assume good faith — no guilt, no "you missed our meeting" framing. Acknowledge calendars get busy, restate the one reason it is worth a few minutes (getting their free Sobriety Select profile claimed and live so families searching their region can find them), and make re-booking effortless.

RULES:
- 70 words max. One clear re-book ask.
- HONEST: never promise outcomes ("fill your beds", guaranteed calls/admissions) and never claim they are invisible or that families "can't find" them. The free profile improves discoverability; it does not guarantee volume.
- When a BOOKING LINK is provided, close with a soft re-book ask and paste that exact URL once as plain text. Otherwise offer two concrete time options.
- No banned hype words (revolutionary, game-changer, guaranteed, unlock).

${DRAFT_VOICE_RULES}

Output JSON: { "subject": string, "body": string }`;

type LeadFacts = Pick<Lead, 'name' | 'city' | 'state' | 'services'>;
type EnrichmentFacts = Pick<Enrichment, 'ownerName' | 'ownerTitle' | 'expectedProduct'>;

export const buildRescheduleUser = (
  lead: LeadFacts,
  enrichment: EnrichmentFacts,
  daysSinceMeeting: number,
  bookingLink: string | null,
): string => {
  const lines: string[] = [
    `facility: ${lead.name}`,
    `city: ${lead.city}`,
    `state: ${lead.state}`,
    `daysSinceMeeting: ${daysSinceMeeting}`,
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
  // internal_tier informs tone only — never name the tier in the email.
  if (enrichment.expectedProduct !== null) {
    lines.push(`internal_tier: ${enrichment.expectedProduct}`);
  }
  if (bookingLink !== null && bookingLink !== '') {
    lines.push(`BOOKING LINK (include exactly once in the closing as plain text): ${bookingLink}`);
  }
  return lines.join('\n');
};
