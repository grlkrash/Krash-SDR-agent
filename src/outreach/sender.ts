// Send an approved Draft via Gmail, then log a HubSpot Email engagement.
//
// Order of operations matters: Gmail send is the irreversible step. Once it
// succeeds we (1) flip the Draft to status='sent' so a retry doesn't double-
// send, then (2) attempt the HubSpot engagement as a best-effort decoration.
// HubSpot failures never propagate — the email is already out the door, so
// we audit and move on. The DB-side `Draft.status='sent'` is the source of
// truth; HubSpot is timeline cosmetics.
//
// Voicemail drafts share the Draft table but route through Twilio in Phase
// 8, so we skip them here unconditionally. The cron query in
// src/scripts/sendApproved.ts also filters them, but we re-check defensively.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Draft, Enrichment, Lead } from '@prisma/client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/companies/models/Filter.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import { sendEmail } from '../shared/gmail.js';
import { isExcludedFromCold } from '../shared/exclusion.js';
import { guessEmail } from '../shared/guessEmail.js';
import { twilio } from '../shared/twilio.js';
import { isAutoVoicemailAllowed } from '../shared/voicemailEligibility.js';

const HUBSPOT_EMAIL_DIRECTION = 'EMAIL';
const HUBSPOT_EMAIL_STATUS_SENT = 'SENT';
const SEARCH_LIMIT = 1;
const TWILIO_MACHINE_DETECTION = 'DetectMessageEnd';
const TWILIO_MACHINE_DETECTION_TIMEOUT = 30;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const audit = (
  action: string,
  draftId: string,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'Draft', entityId: draftId, meta } });

const findContactIdByEmail = async (email: string): Promise<string | null> => {
  const res = await hsRetry(() =>
    hs.crm.contacts.searchApi.doSearch({
      filterGroups: [{
        filters: [{
          propertyName: 'email',
          operator: FilterOperatorEnum.Eq,
          value: email,
        }],
      }],
      properties: ['email'],
      limit: SEARCH_LIMIT,
    }),
  );
  return res.results[0]?.id ?? null;
};

const logHubspotEngagement = async (opts: {
  draftId: string;
  subject: string | null;
  body: string;
  sentAt: Date;
  targetEmail: string;
  companyId: string | null;
}): Promise<void> => {
  try {
    const contactId = await findContactIdByEmail(opts.targetEmail);
    if (contactId === null && opts.companyId === null) {
      // No HubSpot anchors → an unanchored engagement would never surface
      // in any timeline, so don't create one.
      await audit('hubspotEngagement.skipped-no-associations', opts.draftId, {
        targetEmail: opts.targetEmail,
      });
      return;
    }

    const created = await hsRetry(() =>
      hs.crm.objects.emails.basicApi.create({
        properties: {
          hs_timestamp: opts.sentAt.getTime().toString(),
          hs_email_direction: HUBSPOT_EMAIL_DIRECTION,
          hs_email_subject: opts.subject ?? '',
          hs_email_html: opts.body,
          hs_email_status: HUBSPOT_EMAIL_STATUS_SENT,
          hubspot_owner_id: process.env.HUBSPOT_OWNER_ID ?? '',
        },
        associations: [],
      }),
    );

    // Associate after create so HubSpot resolves the v4 association type IDs
    // (188/198/etc.) instead of us hard-coding them. Each association is
    // independent — partial success still beats orphaned engagement.
    if (contactId !== null) {
      await hsRetry(() =>
        hs.crm.associations.v4.basicApi.createDefault('emails', created.id, 'contacts', contactId),
      );
    }
    const companyId = opts.companyId;
    if (companyId !== null) {
      await hsRetry(() =>
        hs.crm.associations.v4.basicApi.createDefault('emails', created.id, 'companies', companyId),
      );
    }

    await prisma.draft.update({
      where: { id: opts.draftId },
      data: { hubspotEmailId: created.id },
    });
    await audit('hubspotEngagement.logged', opts.draftId, {
      emailId: created.id,
      contactId,
      companyId: opts.companyId,
    });
  } catch (err) {
    await audit('hubspotEngagement.failed', opts.draftId, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

type LeadWithEnrichment = Lead & { enrichment: Enrichment | null };

const dropVoicemailViaTwilio = async (
  draft: Draft,
  lead: LeadWithEnrichment,
): Promise<void> => {
  if (draft.twilioCallSid !== null) {
    await audit('sender.voicemail-already-dropped', draft.id, { callSid: draft.twilioCallSid });
    return;
  }
  if (lead.doNotContact) {
    await prisma.draft.update({
      where: { id: draft.id },
      data: { status: 'sent-suppressed' },
    });
    await audit('sender.voicemail-do-not-contact', draft.id, { leadId: lead.id });
    return;
  }
  if (lead.phoneE164 === null) {
    await prisma.draft.update({
      where: { id: draft.id },
      data: { status: 'sent-suppressed' },
    });
    await audit('sender.voicemail-no-phone', draft.id, { leadId: lead.id });
    return;
  }
  const phoneE164 = lead.phoneE164;
  const suppression = await prisma.suppression.findFirst({ where: { phoneE164 } });
  if (suppression !== null) {
    await prisma.draft.update({
      where: { id: draft.id },
      data: { status: 'sent-suppressed' },
    });
    await audit('sender.voicemail-suppressed', draft.id, {
      leadId: lead.id,
      phoneE164,
      reason: suppression.reason,
    });
    return;
  }

  // Re-check eligibility at send time. The state matrix could have been
  // tightened between draft-time and now; we'd rather mark the draft
  // sent-suppressed than fire into a newly-restricted jurisdiction.
  const eligibility = isAutoVoicemailAllowed(phoneE164, lead.state, lead.priorWrittenConsent);
  if (!eligibility.allowed) {
    await prisma.draft.update({
      where: { id: draft.id },
      data: { status: 'sent-suppressed' },
    });
    await audit('sender.voicemail-state-law-blocked', draft.id, {
      leadId: lead.id,
      phoneE164,
      state: lead.state,
      reason: eligibility.reason,
    });
    return;
  }

  const publicUrl = process.env.PUBLIC_URL ?? '';
  const fromNumber = process.env.TWILIO_FROM_NUMBER ?? '';
  const call = await twilio.calls.create({
    to: phoneE164,
    from: fromNumber,
    machineDetection: TWILIO_MACHINE_DETECTION,
    machineDetectionTimeout: TWILIO_MACHINE_DETECTION_TIMEOUT,
    statusCallback: `${publicUrl}/webhook/twilio/status?draftId=${draft.id}`,
    url: `${publicUrl}/webhook/twilio/twiml?draftId=${draft.id}`,
  });
  await prisma.draft.update({
    where: { id: draft.id },
    data: { twilioCallSid: call.sid, status: 'voicemail-dropped', sentAt: new Date() },
  });
  await audit('sender.voicemail-dropped', draft.id, {
    leadId: lead.id,
    callSid: call.sid,
    phoneE164,
  });
};

export const sendApprovedDraft = async (draftId: string): Promise<void> => {
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    include: { lead: { include: { enrichment: true } } },
  });
  if (draft === null) return;
  if (draft.status !== 'approved') return;
  if (draft.kind === 'voicemail' || draft.kind === 'voicemail-2') {
    const { lead: voicemailLead, ...voicemailDraft } = draft;
    await dropVoicemailViaTwilio(voicemailDraft, voicemailLead);
    return;
  }

  const lead = draft.lead;
  const enrichment = lead.enrichment;

  const coldAxis =
    draft.kind === 'cold'
    || draft.kind.startsWith('followup-');
  if (coldAxis && isExcludedFromCold(lead)) {
    await prisma.draft.update({
      where: { id: draftId },
      data: { status: 'sent-suppressed' },
    });
    await audit('sender.excluded', draftId, { leadId: lead.id, kind: draft.kind });
    return;
  }

  const targetEmail =
    enrichment?.ownerEmail
      ?? guessEmail(enrichment?.ownerName ?? null, lead.website);

  if (targetEmail === null) {
    await prisma.draft.update({
      where: { id: draftId },
      data: { status: 'sent-suppressed' },
    });
    await audit('sender.no-email', draftId, { leadId: lead.id });
    return;
  }

  const suppression = await prisma.suppression.findFirst({
    where: { email: targetEmail },
  });
  if (suppression !== null) {
    await prisma.draft.update({
      where: { id: draftId },
      data: { status: 'sent-suppressed' },
    });
    await audit('sender.suppressed', draftId, {
      leadId: lead.id,
      email: targetEmail,
      reason: suppression.reason,
    });
    return;
  }

  const subject = draft.subject ?? '';
  const gmailMessageId = await sendEmail({
    to: targetEmail,
    subject,
    body: draft.body,
  });

  const sentAt = new Date();
  await prisma.draft.update({
    where: { id: draftId },
    data: { status: 'sent', sentAt, gmailMessageId },
  });
  await audit('sender.sent', draftId, {
    leadId: lead.id,
    email: targetEmail,
    gmailMessageId,
  });

  await logHubspotEngagement({
    draftId,
    subject: draft.subject,
    body: draft.body,
    sentAt,
    targetEmail,
    companyId: lead.hubspotCompanyId,
  });
};
