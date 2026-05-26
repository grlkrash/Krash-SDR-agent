// Follow-up sequencer.
//
// Sequence state is derived from Draft history (PRD §8: there is no Sequence
// table). For a given lead we read every "sent" or "auto-sent" draft whose
// kind is on the cold/follow-up axis, count them, and use that count as the
// current step. The cold draft is always step 1 (drafts[0] after sentAt ASC),
// follow-ups are steps 2..5. A draft with kind='replied' acts as a terminal
// signal — once it appears we never touch the lead again.
//
// Order of operations on send mirrors sender.ts intent but flips one step:
// the spec for follow-ups is to persist the Draft (status='auto-sent') BEFORE
// the Gmail send, then patch sentAt + gmailMessageId after. If Gmail throws,
// the orphaned auto-sent row will have sentAt=null and the next sequencer run
// short-circuits in getSequenceState — operator triages from AuditLog.
//
// HubSpot engagement logging duplicates sender.ts's shape on purpose: the
// sender helpers aren't exported, and refactoring them is out of scope for
// this prompt. Engagement failures never propagate — Gmail send is the
// irreversible step; HubSpot is timeline cosmetics.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Draft } from '@prisma/client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/companies/models/Filter.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import { sendEmail } from '../shared/gmail.js';
import { guessEmail } from '../shared/guessEmail.js';
import { businessDay } from '../shared/businessDays.js';
import { FOLLOWUP_TEMPLATES } from '../prompts/followUpTemplates.js';

const SEQUENCE_KINDS = ['cold', 'followup-2', 'followup-3', 'followup-4', 'followup-5'];
const SENT_STATUSES = ['sent', 'auto-sent'];
// Days from step N to step N+1, keyed by current step. cold=1.
const STEP_INTERVALS_DAYS: Record<number, number> = { 1: 3, 2: 4, 3: 7, 4: 16 };
const DEFAULT_INTERVAL_DAYS = 3;
const MAX_STEP = 5;
const NEXT_QUARTER_PHRASE = '2-3 weeks';
const HUBSPOT_EMAIL_DIRECTION = 'EMAIL';
const HUBSPOT_EMAIL_STATUS_SENT = 'SENT';
const HUBSPOT_SEARCH_LIMIT = 1;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const audit = (
  action: string,
  draftId: string,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'Draft', entityId: draftId, meta } });

type SequenceState =
  | { status: 'replied' }
  | { status: 'completed' }
  | { status: 'active'; nextStep: number; nextSendAt: Date; coldDraft: Draft };

const getSequenceState = async (leadId: string): Promise<SequenceState | null> => {
  const drafts = await prisma.draft.findMany({
    where: {
      leadId,
      kind: { in: SEQUENCE_KINDS },
      status: { in: SENT_STATUSES },
    },
    orderBy: { sentAt: 'asc' },
  });
  if (drafts.length === 0) return null;

  const replied = await prisma.draft.findFirst({
    where: { leadId, kind: 'replied' },
    select: { id: true },
  });
  if (replied !== null) return { status: 'replied' };

  const lastStep = drafts.length;
  const lastDraft = drafts[drafts.length - 1];
  const lastSentAt = lastDraft?.sentAt ?? null;
  // Defensive: a row with status in SENT_STATUSES but sentAt=null means a
  // prior sequencer run created the Draft but Gmail send threw. Don't advance.
  if (lastSentAt === null) return null;

  const nextStep = lastStep + 1;
  if (nextStep > MAX_STEP) return { status: 'completed' };

  const interval = STEP_INTERVALS_DAYS[lastStep] ?? DEFAULT_INTERVAL_DAYS;
  const nextSendAt = businessDay(lastSentAt, interval);
  const coldDraft = drafts[0];
  if (coldDraft === undefined) return null;
  return { status: 'active', nextStep, nextSendAt, coldDraft };
};

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
      limit: HUBSPOT_SEARCH_LIMIT,
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

export const runSequenceStep = async (leadId: string): Promise<void> => {
  const state = await getSequenceState(leadId);
  if (state === null) return;
  if (state.status !== 'active') return;
  if (state.nextSendAt > new Date()) return;

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) return;
  const enrichment = lead.enrichment;
  if (enrichment === null) return;
  if (lead.doNotContact) return;

  const template = FOLLOWUP_TEMPLATES[state.nextStep];
  if (template === undefined) return;

  const ctx = {
    facility: lead.name,
    googleReviews: lead.googleReviews ?? undefined,
    nextQ: NEXT_QUARTER_PHRASE,
    phone: process.env.SONIA_PHONE,
    signals: enrichment.signals,
  };
  const { body } = template(ctx);
  const subject = `Re: ${state.coldDraft.subject ?? ''}`;

  const targetEmail =
    enrichment.ownerEmail ?? guessEmail(enrichment.ownerName, lead.website);
  if (targetEmail === null) {
    await audit('sequencer.no-email', state.coldDraft.id, { leadId });
    return;
  }

  const suppression = await prisma.suppression.findFirst({
    where: { email: targetEmail },
  });
  if (suppression !== null) {
    await audit('sequencer.suppressed', state.coldDraft.id, {
      leadId,
      email: targetEmail,
      reason: suppression.reason,
    });
    return;
  }

  const draft = await prisma.draft.create({
    data: {
      leadId,
      kind: `followup-${state.nextStep}`,
      subject,
      body,
      status: 'auto-sent',
    },
  });

  // inReplyTo / references both point at the cold draft's Gmail Message-ID so
  // Gmail threads the entire sequence under the original conversation.
  const threadAnchor = state.coldDraft.gmailMessageId ?? undefined;
  const gmailMessageId = await sendEmail({
    to: targetEmail,
    subject,
    body,
    inReplyTo: threadAnchor,
    references: threadAnchor,
  });

  const sentAt = new Date();
  await prisma.draft.update({
    where: { id: draft.id },
    data: { sentAt, gmailMessageId },
  });
  await audit('sequencer.sent', draft.id, {
    leadId,
    step: state.nextStep,
    email: targetEmail,
    gmailMessageId,
  });

  await logHubspotEngagement({
    draftId: draft.id,
    subject,
    body,
    sentAt,
    targetEmail,
    companyId: lead.hubspotCompanyId,
  });
};
