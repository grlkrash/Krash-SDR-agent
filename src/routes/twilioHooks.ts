// Twilio webhook + audio routes.
//
// Three endpoints, all UNAUTHENTICATED on purpose (Twilio fetches them with
// no shared secret — per PRD §9.9 / Prompt 8.2). Webhook signature validation
// is a future hardening pass; for now, the only side effects are AuditLog
// rows + HubSpot timeline engagements, both of which we can clean up.
//
// 1. POST /webhook/twilio/twiml?draftId=... — Twilio hits this after machine
//    detection completes; we return TwiML that plays the MP3 if a machine
//    answered, hangs up if a human picked up.
// 2. POST /webhook/twilio/status?draftId=... — call lifecycle status callback;
//    we log the full body to AuditLog + write a HubSpot CALL engagement.
// 3. GET /audio/:draftId — serves the raw MP3 buffer Twilio's <Play> verb
//    fetches. No auth (Twilio's fetcher doesn't carry one).

import express from 'express';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { hs, hsRetry } from '../shared/hubspot.js';

const CONNECTED = 'connected';
const NO_ANSWER = 'no-answer';
const HUBSPOT_CALL_DIRECTION = 'OUTBOUND';
const MACHINE_END_BEEP = 'machine_end_beep';
const CALL_STATUS_COMPLETED = 'completed';

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

const logHubspotCallEngagement = async (opts: {
  draftId: string;
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
    const disposition =
      opts.answeredBy === MACHINE_END_BEEP ? CONNECTED : NO_ANSWER;
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
  const draft = await prisma.draft.findUnique({ where: { id: draftId }, select: { id: true } });
  if (draft === null) {
    res.type('text/xml').send('<Response><Hangup/></Response>');
    return;
  }
  const answeredBy = body.AnsweredBy ?? '';
  if (!answeredBy.startsWith('machine')) {
    res.type('text/xml').send('<Response><Hangup/></Response>');
    return;
  }
  const publicUrl = process.env.PUBLIC_URL ?? '';
  const audioUrl = `${publicUrl}/audio/${escapeXml(draftId)}`;
  res.type('text/xml').send(`<Response><Play>${audioUrl}</Play></Response>`);
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
    include: { lead: { select: { hubspotCompanyId: true } } },
  });
  if (draft !== null) {
    await logHubspotCallEngagement({
      draftId,
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
