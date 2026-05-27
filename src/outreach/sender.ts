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
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/companies/models/Filter.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import { sendEmail } from '../shared/gmail.js';
import { isExcludedFromCold } from '../shared/exclusion.js';
import { guessEmail } from '../shared/guessEmail.js';

const HUBSPOT_EMAIL_DIRECTION = 'EMAIL';
const HUBSPOT_EMAIL_STATUS_SENT = 'SENT';
const SEARCH_LIMIT = 1;

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

export const sendApprovedDraft = async (draftId: string): Promise<void> => {
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    include: { lead: { include: { enrichment: true } } },
  });
  if (draft === null) return;
  if (draft.status !== 'approved') return;
  // Voicemail goes through Twilio in Phase 8 — different code path entirely.
  if (draft.kind === 'voicemail') return;

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
