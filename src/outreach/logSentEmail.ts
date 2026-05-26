// Log a HubSpot Email engagement when the operator marks a cold Draft as
// sent. Best-effort: failures are caught and audited but never propagated,
// so a HubSpot outage can't block the /mark-sent redirect. The DB-side
// `Draft.status = 'sent'` is the source of truth; HubSpot is decoration so
// the contact's timeline reflects the send.
//
// Idempotent: if `Draft.hubspotEmailId` is already set, returns it without
// re-calling HubSpot. The `/mark-sent` UI only renders for status='approved'
// so user-driven double-fires shouldn't happen, but this also covers script
// retries.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/companies/models/Filter.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import { guessEmail } from '../shared/guessEmail.js';

const HUBSPOT_EMAIL_DIRECTION_OUTBOUND = 'EMAIL';
const HUBSPOT_EMAIL_STATUS_SENT = 'SENT';
// HubSpot rejects email bodies above ~64KB. Truncating defensively keeps the
// engagement create call from blowing up on the rare oversized draft.
const BODY_MAX_CHARS = 60000;
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

const createEmailEngagement = async (
  subject: string | null,
  body: string,
  sentAt: Date,
): Promise<string> => {
  const properties: Record<string, string> = {
    hs_timestamp: sentAt.getTime().toString(),
    hs_email_direction: HUBSPOT_EMAIL_DIRECTION_OUTBOUND,
    hs_email_status: HUBSPOT_EMAIL_STATUS_SENT,
    hs_email_subject: subject ?? '',
    hs_email_text: body.slice(0, BODY_MAX_CHARS),
  };
  const created = await hsRetry(() =>
    hs.crm.objects.emails.basicApi.create({ properties, associations: [] }),
  );
  return created.id;
};

export const logSentEmailToHubspot = async (
  draftId: string,
): Promise<string | null> => {
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    include: { lead: { include: { enrichment: true } } },
  });
  if (draft === null) return null;
  // Only cold drafts log as Email engagements. Voicemail / call drafts have
  // their own engagement types and are handled elsewhere when wired.
  if (draft.kind !== 'cold') return null;
  if (draft.hubspotEmailId !== null) return draft.hubspotEmailId;

  const lead = draft.lead;
  const enrichment = lead.enrichment;
  const targetEmail =
    enrichment?.ownerEmail
      ?? guessEmail(enrichment?.ownerName ?? null, lead.website);
  const companyId = lead.hubspotCompanyId;

  try {
    const contactId =
      targetEmail === null ? null : await findContactIdByEmail(targetEmail);
    if (contactId === null && companyId === null) {
      // No HubSpot anchors → nothing to associate. Skip cleanly rather than
      // create an orphan engagement that would never surface in any timeline.
      await audit('hubspotEngagement.skipped-no-associations', draftId, {
        hasEmail: targetEmail !== null,
        hasCompanyId: companyId !== null,
      });
      return null;
    }

    const emailId = await createEmailEngagement(
      draft.subject,
      draft.body,
      draft.sentAt ?? new Date(),
    );

    // Associate to whatever anchors we have. `createDefault` lets HubSpot
    // resolve the right type IDs internally (188/198/etc.) so we don't
    // hard-code them. Each association is independent — if contact succeeds
    // but company fails, we still keep the contact link.
    if (contactId !== null) {
      await hsRetry(() =>
        hs.crm.associations.v4.basicApi.createDefault(
          'emails',
          emailId,
          'contacts',
          contactId,
        ),
      );
    }
    if (companyId !== null) {
      await hsRetry(() =>
        hs.crm.associations.v4.basicApi.createDefault(
          'emails',
          emailId,
          'companies',
          companyId,
        ),
      );
    }

    await prisma.draft.update({
      where: { id: draftId },
      data: { hubspotEmailId: emailId },
    });

    await audit('hubspotEngagement.logged', draftId, {
      emailId,
      contactId,
      companyId,
    });
    return emailId;
  } catch (err) {
    await audit('hubspotEngagement.failed', draftId, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
};
