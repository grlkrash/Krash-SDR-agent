// Voicemail drop drafter.
//
// dropVoicemail loads a lead, generates a 25-second TTS script via Claude,
// renders it to MP3 via ElevenLabs, and persists a Draft of kind='voicemail'
// in 'pending' status so the operator can approve it from /queue. After
// approval, src/outreach/sender.ts routes the draft to Twilio (AMD voicemail
// drop — the phone rings; MP3 plays only when Twilio detects a machine).
//
// Idempotency / safety rails:
// - Skip if phone is unknown, lead.doNotContact, or phoneE164 is in Suppression.
// - One voicemail draft per lead total (any non-rejected status counts).
// - Mobile/VoIP numbers persist a 'voicemail-skipped-mobile' draft and never
//   attempt a drop. The Twilio Lookups Line Type Intelligence call is the
//   TCPA gate — running it BEFORE we pay ElevenLabs for the audio buffer.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { claude, extractText } from '../shared/claude.js';
import { isLandline } from '../shared/twilio.js';
import { renderVoicemailMp3 } from '../shared/eleven.js';
import { isAutoVoicemailAllowed } from '../shared/voicemailEligibility.js';
import {
  VOICEMAIL_SCRIPT_SYSTEM,
  buildVoicemailScriptUser,
} from '../prompts/voicemailScript.js';

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 200;
const TEMPERATURE = 0.6;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const audit = (
  action: string,
  leadId: string,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'Lead', entityId: leadId, meta } });

const cached = (text: string): Array<TextBlockParam> => [
  { type: 'text', text, cache_control: { type: 'ephemeral' } },
];

export const dropVoicemail = async (leadId: string): Promise<void> => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) return;
  const enrichment = lead.enrichment;
  if (enrichment === null) return;

  if (lead.phoneE164 === null) {
    await audit('voicemail.skipped-no-phone', leadId, {});
    return;
  }
  if (lead.doNotContact) {
    await audit('voicemail.skipped-do-not-contact', leadId, {});
    return;
  }
  const phoneE164 = lead.phoneE164;
  const suppression = await prisma.suppression.findFirst({ where: { phoneE164 } });
  if (suppression !== null) {
    await audit('voicemail.skipped-suppressed', leadId, { reason: suppression.reason });
    return;
  }

  const existing = await prisma.draft.findFirst({
    where: { leadId, kind: 'voicemail', status: { not: 'rejected' } },
    select: { id: true, status: true },
  });
  if (existing !== null) {
    await audit('voicemail.skipped-existing', leadId, {
      draftId: existing.id,
      status: existing.status,
    });
    return;
  }

  // State / country gate. Runs BEFORE any paid API call (Twilio Lookups,
  // Claude, ElevenLabs) so blocked leads cost us $0. Tombstone draft tells
  // future ticks not to retry and surfaces the lead in the daily brief's
  // "manual VM required" section.
  const eligibility = isAutoVoicemailAllowed(phoneE164, lead.state, lead.priorWrittenConsent);
  if (!eligibility.allowed) {
    await prisma.draft.create({
      data: {
        leadId,
        kind: 'voicemail',
        body: `(skipped — ${eligibility.reason}; manual outreach required)`,
        status: 'voicemail-skipped-state-law',
      },
    });
    await audit('voicemail.skipped-state-law', leadId, {
      phoneE164,
      state: lead.state,
      reason: eligibility.reason,
    });
    return;
  }

  const phoneCallback = process.env.SONIA_PHONE ?? '';
  // Twilio Lookups Line Type Intelligence — landline-only is the TCPA gate.
  // VoIP/mobile/unknown all return false → we persist a tombstone draft so
  // we don't retry on the next dropVoicemails tick. Costs $0.008/lookup.
  const landline = await isLandline(phoneE164);
  if (!landline) {
    await prisma.draft.create({
      data: {
        leadId,
        kind: 'voicemail',
        body: '(skipped — mobile / VoIP / unknown line type)',
        status: 'voicemail-skipped-mobile',
      },
    });
    await audit('voicemail.skipped-mobile', leadId, { phoneE164 });
    return;
  }

  const msg = await claude.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: cached(VOICEMAIL_SCRIPT_SYSTEM),
    messages: [{
      role: 'user',
      content: buildVoicemailScriptUser(lead, enrichment, phoneCallback),
    }],
  });
  const script = extractText(msg).trim();
  if (script === '') {
    await audit('voicemail.empty-script', leadId, {});
    return;
  }

  const mp3 = await renderVoicemailMp3(script);

  const draft = await prisma.draft.create({
    data: {
      leadId,
      kind: 'voicemail',
      body: script,
      audioMp3: mp3,
      status: 'pending',
    },
  });
  await audit('voicemail.drafted', leadId, {
    draftId: draft.id,
    scriptLength: script.length,
    audioBytes: mp3.length,
  });
};
