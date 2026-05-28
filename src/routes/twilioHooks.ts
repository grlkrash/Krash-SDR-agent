// Twilio webhook + audio routes.
//
// Three endpoints, all UNAUTHENTICATED on purpose (Twilio fetches them with
// no shared secret — per PRD §9.9 / Prompt 8.2). Webhook signature validation
// is a future hardening pass; for now, the only side effects are AuditLog
// rows + HubSpot timeline engagements, both of which we can clean up.
//
// 1. POST /webhook/twilio/twiml?draftId=... — Twilio hits this after AMD
//    (Answering Machine Detection) completes. Machine → play pre-rendered MP3.
//    Human on vm-1 → hang up. Human on vm-2 → bridge to Sonia (gatekeeper or
//    owner — she handles live). This is NOT ringless voicemail; the callee's
//    phone rings like a normal outbound call.
// 2. POST /webhook/twilio/status?draftId=... — call lifecycle status callback;
//    we log the full body to AuditLog + write a HubSpot CALL engagement.
// 3. GET /audio/:draftId — serves the raw MP3 buffer Twilio's <Play> verb
//    fetches. No auth (Twilio's fetcher doesn't carry one).

import express from 'express';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { hs, hsRetry } from '../shared/hubspot.js';
import { sendEmail } from '../shared/gmail.js';
import {
  buildPrepBriefEmail,
  buildWhisperText,
} from '../shared/prepBriefForCall.js';

const CONNECTED = 'connected';
const NO_ANSWER = 'no-answer';
const HUBSPOT_CALL_DIRECTION = 'OUTBOUND';
const MACHINE_END_BEEP = 'machine_end_beep';
const CALL_STATUS_COMPLETED = 'completed';
const BRIDGE_TIMEOUT_SECONDS = 20;
const VOICEMAIL_2_KIND = 'voicemail-2';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const audit = (
  action: string,
  draftId: string | null,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'Draft', entityId: draftId, meta } });

const escapeXml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&apos;';
  });

const DraftIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+$/);
const parseDraftId = (raw: unknown): string | null => {
  const result = DraftIdSchema.safeParse(raw);
  return result.success ? result.data : null;
};

// Twilio sends application/x-www-form-urlencoded; every value is a string.
// We keep the whole body as Record<string, string> so AuditLog gets the full
// payload without any unknown-shaped narrowing escape hatch.
const TwilioBody = z.record(z.string(), z.string());
type TwilioBodyShape = z.infer<typeof TwilioBody>;

const computeDisposition = (kind: string, answeredBy: string): string => {
  if (answeredBy === MACHINE_END_BEEP) return CONNECTED;
  // Voicemail-2 + human answer = bridge attempted. The bridge's actual
  // outcome (Sonia picked up vs missed) lives in the dial-result audit;
  // HubSpot just sees "we connected with a human."
  if (kind === VOICEMAIL_2_KIND && answeredBy === 'human') return CONNECTED;
  return NO_ANSWER;
};

const logHubspotCallEngagement = async (opts: {
  draftId: string;
  kind: string;
  companyId: string | null;
  callStatus: string;
  answeredBy: string;
  callSid: string;
}): Promise<void> => {
  try {
    if (opts.companyId === null) {
      await audit('voicemail.hubspot-skipped-no-company', opts.draftId, {
        callSid: opts.callSid,
      });
      return;
    }
    const disposition = computeDisposition(opts.kind, opts.answeredBy);
    const created = await hsRetry(() =>
      hs.crm.objects.calls.basicApi.create({
        properties: {
          hs_timestamp: Date.now().toString(),
          hs_call_direction: HUBSPOT_CALL_DIRECTION,
          hs_call_status: opts.callStatus,
          hs_call_disposition: disposition,
          hubspot_owner_id: process.env.HUBSPOT_OWNER_ID ?? '',
        },
        associations: [],
      }),
    );
    await hsRetry(() =>
      hs.crm.associations.v4.basicApi.createDefault(
        'calls', created.id, 'companies', opts.companyId ?? '',
      ),
    );
    await audit('voicemail.hubspot-logged', opts.draftId, {
      callEngagementId: created.id,
      companyId: opts.companyId,
      disposition,
    });
  } catch (err) {
    await audit('voicemail.hubspot-failed', opts.draftId, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export const twilioRouter = express.Router();

// Twilio webhooks ship form-urlencoded bodies. Keep the parser local to this
// router so the rest of the app stays JSON-only.
twilioRouter.use('/webhook/twilio', express.urlencoded({ extended: false }));

const rawQueryAsString = (v: unknown): string | null =>
  typeof v === 'string' ? v : null;

const parseTwilioBody = (body: unknown): TwilioBodyShape => {
  if (body === null || typeof body !== 'object') return {};
  const result = TwilioBody.safeParse(body);
  return result.success ? result.data : {};
};

const sendPrepBriefIfPossible = async (
  draftId: string,
  recipient: string,
  emailBody: { subject: string; body: string },
): Promise<void> => {
  try {
    await sendEmail({ to: recipient, subject: emailBody.subject, body: emailBody.body });
    await audit('voicemail2.prep-brief-sent', draftId, { recipient });
  } catch (err) {
    await audit('voicemail2.prep-brief-failed', draftId, {
      recipient,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

twilioRouter.post('/webhook/twilio/twiml', async (req, res) => {
  const draftId = parseDraftId(req.query.draftId);
  if (draftId === null) {
    await audit('voicemail.twiml-bad-draft-id', null, {
      rawDraftId: rawQueryAsString(req.query.draftId),
    });
    res.type('text/xml').send('<Response><Hangup/></Response>');
    return;
  }
  const body = parseTwilioBody(req.body);
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      kind: true,
      lead: { include: { enrichment: true } },
    },
  });
  if (draft === null) {
    res.type('text/xml').send('<Response><Hangup/></Response>');
    return;
  }
  const answeredBy = body.AnsweredBy ?? '';
  const publicUrl = process.env.PUBLIC_URL ?? '';

  // Machine answered → drop the pre-rendered MP3 (same path for vm-1 and vm-2).
  if (answeredBy.startsWith('machine')) {
    const audioUrl = `${publicUrl}/audio/${escapeXml(draftId)}`;
    res.type('text/xml').send(`<Response><Play>${audioUrl}</Play></Response>`);
    return;
  }

  // Human answered. For voicemail-1 the spec is to hang up (we only run on
  // landlines and the prospect picking up a business line is unexpected).
  if (draft.kind !== VOICEMAIL_2_KIND) {
    res.type('text/xml').send('<Response><Hangup/></Response>');
    return;
  }

  // Voicemail-2 + human pickup = the bridge case. Email Sonia the prep
  // brief synchronously (Gmail send ~600ms, well under Twilio's 5s soft
  // timeout), then return TwiML that dials Sonia with a whisper.
  const sonia = process.env.SONIA_PHONE ?? '';
  const recipient = process.env.BRIEF_RECIPIENT ?? '';
  if (sonia === '') {
    await audit('voicemail2.bridge-no-sonia-phone', draftId, {});
    res.type('text/xml').send('<Response><Hangup/></Response>');
    return;
  }
  if (recipient !== '') {
    const emailBody = buildPrepBriefEmail(draft.lead, draft.lead.enrichment);
    await sendPrepBriefIfPossible(draftId, recipient, emailBody);
  }

  const whisperUrl = `${publicUrl}/webhook/twilio/whisper?draftId=${escapeXml(draftId)}`;
  const dialResultUrl = `${publicUrl}/webhook/twilio/dial-result?draftId=${escapeXml(draftId)}`;
  const twiml = `<Response><Dial timeout="${BRIDGE_TIMEOUT_SECONDS}" answerOnBridge="true" action="${dialResultUrl}"><Number url="${whisperUrl}">${escapeXml(sonia)}</Number></Dial></Response>`;

  await audit('voicemail2.bridge-initiated', draftId, {
    sonia,
    recipient,
  });
  res.type('text/xml').send(twiml);
});

// Played in SONIA's ear before the bridge connects. Twilio's built-in
// <Say> voice (free, ~instant) — not ElevenLabs — since this is for
// Sonia's ear only and we need zero added latency.
twilioRouter.post('/webhook/twilio/whisper', async (req, res) => {
  const draftId = parseDraftId(req.query.draftId);
  if (draftId === null) {
    res.type('text/xml').send('<Response></Response>');
    return;
  }
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    select: { lead: { include: { enrichment: true } } },
  });
  if (draft === null) {
    res.type('text/xml').send('<Response></Response>');
    return;
  }
  const text = buildWhisperText(draft.lead, draft.lead.enrichment);
  await audit('voicemail2.whisper-served', draftId, { whisperText: text });
  res.type('text/xml').send(`<Response><Say>${escapeXml(text)}</Say></Response>`);
});

// Action URL on the <Dial>. Fires after the dial leg ends (whether Sonia
// connected, didn't answer, or the bridge completed). If Sonia connected
// successfully (DialCallStatus='completed'), the prospect has already had
// the conversation — just hang up. Otherwise play a brief apology so the
// prospect doesn't sit in dead air.
twilioRouter.post('/webhook/twilio/dial-result', async (req, res) => {
  const draftId = parseDraftId(req.query.draftId);
  const body = parseTwilioBody(req.body);
  const dialCallStatus = body.DialCallStatus ?? '';

  if (draftId !== null) {
    await audit('voicemail2.dial-result', draftId, body);
  }

  if (dialCallStatus === CALL_STATUS_COMPLETED) {
    res.type('text/xml').send('<Response><Hangup/></Response>');
    return;
  }

  // Missed bridge — Sonia didn't pick up, was busy, or call failed.
  // Apologize and hang up. (We never drop voicemail audio at a LIVE human
  // who just heard ringing — that'd be jarring.)
  res.type('text/xml').send(
    '<Response><Say>Sorry, I just missed you. I will try you back. Thank you.</Say><Hangup/></Response>',
  );
});

twilioRouter.post('/webhook/twilio/status', async (req, res) => {
  const draftId = parseDraftId(req.query.draftId);
  const body = parseTwilioBody(req.body);

  if (draftId === null) {
    await audit('voicemail.status-bad-draft-id', null, {
      rawDraftId: rawQueryAsString(req.query.draftId),
      body,
    });
    res.status(204).end();
    return;
  }

  await audit('voicemail.status', draftId, body);

  const callStatus = body.CallStatus ?? '';
  const answeredBy = body.AnsweredBy ?? '';

  if (callStatus === CALL_STATUS_COMPLETED && answeredBy.startsWith('machine')) {
    await prisma.draft.update({
      where: { id: draftId },
      data: { status: 'voicemail-dropped' },
    });
  }

  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    select: {
      kind: true,
      lead: { select: { hubspotCompanyId: true } },
    },
  });
  if (draft !== null) {
    await logHubspotCallEngagement({
      draftId,
      kind: draft.kind,
      companyId: draft.lead.hubspotCompanyId,
      callStatus,
      answeredBy,
      callSid: body.CallSid ?? '',
    });
  }
  res.status(204).end();
});

twilioRouter.get('/audio/:draftId', async (req, res) => {
  const draftId = parseDraftId(req.params.draftId);
  if (draftId === null) {
    res.status(404).end();
    return;
  }
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    select: { audioMp3: true },
  });
  if (draft === null || draft.audioMp3 === null) {
    res.status(404).end();
    return;
  }
  res.set('Content-Type', 'audio/mpeg');
  res.send(Buffer.from(draft.audioMp3));
});
