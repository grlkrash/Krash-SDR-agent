// Replied-thread drafter prompt. The lead has actually replied to a cold or
// follow-up email — the model's job is to keep the thread moving toward a
// 15-min discovery call without sounding like a template. Tone-match is
// load-bearing here: a curt reply gets a curt response, a chatty reply gets
// a slightly warmer one. The user prompt includes the original cold email
// so the model can ground its response in what it actually pitched.

import type { Draft, Enrichment, Lead } from '@prisma/client';
import { getBookingLink } from '../shared/bookingLink.js';
import { DRAFT_VOICE_RULES } from './draftVoice.js';

export const REPLIED_SYSTEM = `Draft a short, no-fluff response to this reply. Match their energy. Move toward booking a discovery call (use the BOOKING LINK from the user message when provided; paste the URL once as plain text) OR answer their direct question. 60 words max. No greeting fluff, no closing fluff. Match their tone.

${DRAFT_VOICE_RULES}`;

type ColdDraftFacts = Pick<Draft, 'subject' | 'body'>;
type LeadFacts = Pick<Lead, 'name' | 'city' | 'state' | 'website'>;
type EnrichmentFacts = Pick<
  Enrichment,
  'ownerName' | 'ownerTitle' | 'expectedProduct' | 'signals'
>;

export const buildRepliedUser = (
  coldDraft: ColdDraftFacts,
  replyText: string,
  lead: LeadFacts,
  enrichment: EnrichmentFacts | null,
): string => {
  const context = {
    facility: lead.name,
    city: lead.city,
    state: lead.state,
    website: lead.website,
    owner: enrichment === null
      ? null
      : { name: enrichment.ownerName, title: enrichment.ownerTitle },
    internalTier: enrichment?.expectedProduct ?? null,
    signals: enrichment?.signals ?? null,
  };

  const lines = [
    'ORIGINAL COLD EMAIL (this is what they replied to):',
    `Subject: ${coldDraft.subject ?? ''}`,
    '',
    coldDraft.body,
    '',
    'THEIR REPLY:',
    replyText,
    '',
    // Prospect context echoes the cold-email convention: tier label is internal
    // tone-only, never name it, never anchor price before the discovery call.
    'PROSPECT CONTEXT (internal tier is for tone only — never name the tier, never mention price):',
    JSON.stringify(context, null, 2),
  ];
  const bookingLink = getBookingLink();
  if (bookingLink !== null) {
    lines.push('', `BOOKING LINK (include exactly once when inviting them to book): ${bookingLink}`);
  }
  lines.push('', 'Write the reply.');
  return lines.join('\n');
};
