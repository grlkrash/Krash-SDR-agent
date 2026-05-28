// Second-touch voicemail drafter (Day-3 in the cold sequence).
//
// dropVoicemail2 mirrors dropVoicemail's safety cascade but uses the
// voicemail-2 system prompt and skips the isLandline lookup — voicemail-1
// already established the line is a landline (otherwise voicemail-1 would
// have tombstoned as voicemail-skipped-mobile and runSecondCalls wouldn't
// have surfaced this lead).
//
// The behavior split is on the SEND side, not the draft side: voicemail-2
// drafts persist exactly like voicemail-1 (kind='voicemail-2',
// status='pending', audioMp3 populated). The bridge-to-Sonia behavior
// lives in the /webhook/twilio/twiml handler, which branches on draft.kind.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { claude, extractText } from '../shared/claude.js';
import { renderVoicemailMp3 } from '../shared/eleven.js';
import { isAutoVoicemailAllowed } from '../shared/voicemailEligibility.js';
import {
  VOICEMAIL_SCRIPT_2_SYSTEM,
  buildVoicemailScript2User,
} from '../prompts/voicemailScript2.js';

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

export const dropVoicemail2 = async (leadId: string): Promise<void> => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) return;
  const enrichment = lead.enrichment;
  if (enrichment === null) return;

  if (lead.phoneE164 === null) {
    await audit('voicemail2.skipped-no-phone', leadId, {});
    return;
  }
  if (lead.doNotContact) {
    await audit('voicemail2.skipped-do-not-contact', leadId, {});
    return;
  }
  const phoneE164 = lead.phoneE164;

  const suppression = await prisma.suppression.findFirst({ where: { phoneE164 } });
  if (suppression !== null) {
    await audit('voicemail2.skipped-suppressed', leadId, { reason: suppression.reason });
    return;
  }

  // Defense-in-depth: voicemail-1 was only dropped if voicemail-1's
  // eligibility check passed. But the state matrix could have been
  // tightened since (e.g., counsel added a new restricted state). Re-check.
  const eligibility = isAutoVoicemailAllowed(phoneE164, lead.state);
  if (!eligibility.allowed) {
    await prisma.draft.create({
      data: {
        leadId,
        kind: 'voicemail-2',
        body: `(skipped — ${eligibility.reason}; manual outreach required)`,
        status: 'voicemail-skipped-state-law',
      },
    });
    await audit('voicemail2.skipped-state-law', leadId, {
      phoneE164,
      state: lead.state,
      reason: eligibility.reason,
    });
    return;
  }

  const existing = await prisma.draft.findFirst({
    where: { leadId, kind: 'voicemail-2', status: { not: 'rejected' } },
    select: { id: true, status: true },
  });
  if (existing !== null) {
    await audit('voicemail2.skipped-existing', leadId, {
      draftId: existing.id,
      status: existing.status,
    });
    return;
  }

  // Sanity check: voicemail-1 should have dropped successfully. If
  // runSecondCalls is set up correctly this is always true, but the guard
  // costs nothing and protects against manual cron invocations.
  const priorVm = await prisma.draft.findFirst({
    where: { leadId, kind: 'voicemail', status: 'voicemail-dropped' },
    select: { id: true },
  });
  if (priorVm === null) {
    await audit('voicemail2.no-prior-drop', leadId, {});
    return;
  }

  const phoneCallback = process.env.SONIA_PHONE ?? '';
  const msg = await claude.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: cached(VOICEMAIL_SCRIPT_2_SYSTEM),
    messages: [{
      role: 'user',
      content: buildVoicemailScript2User(lead, enrichment, phoneCallback),
    }],
  });
  const script = extractText(msg).trim();
  if (script === '') {
    await audit('voicemail2.empty-script', leadId, {});
    return;
  }

  const mp3 = await renderVoicemailMp3(script);

  const draft = await prisma.draft.create({
    data: {
      leadId,
      kind: 'voicemail-2',
      body: script,
      audioMp3: mp3,
      status: 'pending',
    },
  });
  await audit('voicemail2.drafted', leadId, {
    draftId: draft.id,
    scriptLength: script.length,
    audioBytes: mp3.length,
  });
};
