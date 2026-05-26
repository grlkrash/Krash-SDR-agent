// "Kill lead" — operator-initiated full-stop on outreach. Sets
// Lead.doNotContact, suppresses the known email/phone, cancels every active
// draft for the lead, and best-effort updates the HubSpot contact's native
// hs_lead_status to 'UNQUALIFIED' so HubSpot dashboards reflect the kill.
//
// Idempotent: safe to call twice on the same lead. The HubSpot update is
// best-effort — if no contact exists yet (no hubspotSync run, or no email
// derivable), or the call fails, the DB-side state still lands and we
// AuditLog the HubSpot outcome.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/companies/models/Filter.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import { guessEmail } from '../shared/guessEmail.js';

const HUBSPOT_LEAD_STATUS_UNQUALIFIED = 'UNQUALIFIED';
const REASON_MAX_CHARS = 240;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

export type KillLeadResult = {
  cancelledDrafts: number;
  suppressedEmail: string | null;
  suppressedPhone: string | null;
  hubspotContactId: string | null;
  hubspotError: string | null;
};

// Suppression's PK is composite (email, phoneE164), both defaulting to "". We
// write a single row keyed on whatever identifier(s) we have so the
// downstream `prisma.suppression.findFirst({ where: { email } })` lookup in
// draftCold sees it.
const upsertSuppression = async (
  email: string,
  phone: string,
  reason: string,
): Promise<{ email: string | null; phone: string | null }> => {
  if (email === '' && phone === '') return { email: null, phone: null };
  await prisma.suppression.upsert({
    where: { email_phoneE164: { email, phoneE164: phone } },
    create: { email, phoneE164: phone, reason },
    update: { reason },
  });
  return {
    email: email === '' ? null : email,
    phone: phone === '' ? null : phone,
  };
};

const updateHubspotContactStatus = async (email: string): Promise<string | null> => {
  const search = await hsRetry(() =>
    hs.crm.contacts.searchApi.doSearch({
      filterGroups: [{
        filters: [{
          propertyName: 'email',
          operator: FilterOperatorEnum.Eq,
          value: email,
        }],
      }],
      properties: ['email', 'hs_lead_status'],
      limit: 1,
    }),
  );
  const contactId = search.results[0]?.id ?? null;
  if (contactId === null) return null;
  await hsRetry(() =>
    hs.crm.contacts.basicApi.update(contactId, {
      properties: { hs_lead_status: HUBSPOT_LEAD_STATUS_UNQUALIFIED },
    }),
  );
  return contactId;
};

export const killLead = async (
  leadId: string,
  reason: string,
): Promise<KillLeadResult> => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) throw new Error(`killLead: lead not found: ${leadId}`);

  const trimmedReason = reason.trim().slice(0, REASON_MAX_CHARS);
  const phone = lead.phoneE164 ?? '';
  const targetEmail =
    lead.enrichment?.ownerEmail
      ?? guessEmail(lead.enrichment?.ownerName ?? null, lead.website)
      ?? '';

  await prisma.lead.update({
    where: { id: leadId },
    data: { doNotContact: true },
  });

  const cancelled = await prisma.draft.updateMany({
    where: {
      leadId,
      status: { in: ['pending', 'approved', 'paused'] },
    },
    data: {
      status: 'rejected',
      rejectReason: `Lead killed: ${trimmedReason}`.slice(0, REASON_MAX_CHARS),
    },
  });

  const suppression = await upsertSuppression(
    targetEmail,
    phone,
    `kill-lead: ${trimmedReason}`.slice(0, REASON_MAX_CHARS),
  );

  let hubspotContactId: string | null = null;
  let hubspotError: string | null = null;
  if (targetEmail !== '') {
    try {
      hubspotContactId = await updateHubspotContactStatus(targetEmail);
    } catch (err) {
      hubspotError = err instanceof Error ? err.message : String(err);
      await prisma.auditLog.create({
        data: {
          action: 'killLead.hubspot-failed',
          entity: 'Lead',
          entityId: leadId,
          meta: { error: hubspotError, email: targetEmail },
        },
      });
    }
  }

  await prisma.auditLog.create({
    data: {
      action: 'lead.killed',
      entity: 'Lead',
      entityId: leadId,
      meta: {
        reason: trimmedReason,
        cancelledDrafts: cancelled.count,
        suppressedEmail: suppression.email,
        suppressedPhone: suppression.phone,
        hubspotContactId,
        hubspotError,
        killedBy: 'sonia',
      },
    },
  });

  return {
    cancelledDrafts: cancelled.count,
    suppressedEmail: suppression.email,
    suppressedPhone: suppression.phone,
    hubspotContactId,
    hubspotError,
  };
};
