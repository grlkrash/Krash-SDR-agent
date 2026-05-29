// Voicemail drop drafter — post-sale, consent-gated only.
//
// dropVoicemail drafts vm-1 for leads with Lead.priorWrittenConsent after a
// sent renewal or reactivation email. Drafts land in /queue as reference
// scripts; operator places live calls manually until counsel approves AI send.
//
// Automated Twilio drops require operator approval (currently disabled in /queue).

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { claude, extractText } from '../shared/claude.js';
import { isLandline } from '../shared/twilio.js';
import { renderVoicemailMp3 } from '../shared/eleven.js';
import { formatPhoneForSpeech } from '../shared/formatPhoneForSpeech.js';
import { wrapVoicemailScript, type VoicemailTrigger } from '../shared/voicemailCompliance.js';
import { isAutoVoicemailAllowed } from '../shared/voicemailEligibility.js';
import {
  VOICEMAIL_SCRIPT_SYSTEM,
  buildVoicemailScriptUser,
} from '../prompts/voicemailScript.js';

export type { VoicemailTrigger };

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

export const dropVoicemail = async (
  leadId: string,
  trigger: VoicemailTrigger,
): Promise<void> => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) return;
  const enrichment = lead.enrichment;
  if (enrichment === null) return;

  if (!lead.priorWrittenConsent) {
    await audit('voicemail.skipped-no-consent', leadId, { trigger });
    return;
  }
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

  const phoneCallback = formatPhoneForSpeech(process.env.SONIA_PHONE ?? '');
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
      content: buildVoicemailScriptUser(lead, enrichment, phoneCallback, trigger),
    }],
  });
  const middle = extractText(msg).trim();
  if (middle === '') {
    await audit('voicemail.empty-script', leadId, {});
    return;
  }

  const script = wrapVoicemailScript(middle, {
    callbackPhoneSpeech: phoneCallback,
    touch: 1,
    trigger,
  });
  const mp3 = await renderVoicemailMp3(script);

  const draft = await prisma.draft.create({
    data: {
      leadId,
      kind: 'voicemail',
      body: script,
      audioMp3: mp3,
      status:
        process.env.VM_AI_AUTO_SEND === 'true' && trigger === 'reactivation'
          ? 'approved'
          : 'pending',
    },
  });
  await audit('voicemail.drafted', leadId, {
    draftId: draft.id,
    scriptLength: script.length,
    audioBytes: mp3.length,
    trigger,
    consentGated: true,
  });
};
