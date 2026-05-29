// Follow-up sequencer — drafts only; never sends without /queue approval.
//
// Sequence state is derived from Draft history (PRD §8: there is no Sequence
// table). For a given lead we read every sent cold/follow-up draft, count
// them as the current step, and when the business-day interval elapses we
// create the next touch as status='pending' for Sonia to approve. Sends go
// through sendApproved → sender.ts (same path as cold email).

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { Draft } from '@prisma/client';
import { guessEmail } from '../shared/guessEmail.js';
import { businessDay } from '../shared/businessDays.js';
import { FOLLOWUP_TEMPLATES } from '../prompts/followUpTemplates.js';
import { getBookingLink } from '../shared/bookingLink.js';
import { isExcludedFromCold } from '../shared/exclusion.js';

const SEQUENCE_KINDS = ['cold', 'followup-2', 'followup-3', 'followup-4', 'followup-5'];
const SENT_STATUSES = ['sent', 'auto-sent'];
const QUEUED_STATUSES = ['pending', 'approved'];
// Days from step N to step N+1, keyed by current step. cold=1.
const STEP_INTERVALS_DAYS: Record<number, number> = { 1: 3, 2: 4, 3: 7, 4: 16 };
const DEFAULT_INTERVAL_DAYS = 3;
const MAX_STEP = 5;
const NEXT_QUARTER_PHRASE = '2-3 weeks';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const audit = (
  action: string,
  draftId: string,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'Draft', entityId: draftId, meta } });

export type SequenceState =
  | { status: 'replied' }
  | { status: 'completed' }
  | { status: 'active'; nextStep: number; nextSendAt: Date; coldDraft: Draft };

export const getSequenceState = async (leadId: string): Promise<SequenceState | null> => {
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
  if (lastSentAt === null) return null;

  const nextStep = lastStep + 1;
  if (nextStep > MAX_STEP) return { status: 'completed' };

  const interval = STEP_INTERVALS_DAYS[lastStep] ?? DEFAULT_INTERVAL_DAYS;
  const nextSendAt = businessDay(lastSentAt, interval);
  const coldDraft = drafts[0];
  if (coldDraft === undefined) return null;
  return { status: 'active', nextStep, nextSendAt, coldDraft };
};

export const runSequenceStep = async (leadId: string): Promise<void> => {
  const state = await getSequenceState(leadId);
  if (state === null) return;
  if (state.status !== 'active') return;
  if (state.nextSendAt > new Date()) return;

  const followupKind = `followup-${state.nextStep}`;
  const alreadyQueued = await prisma.draft.findFirst({
    where: {
      leadId,
      kind: followupKind,
      status: { in: QUEUED_STATUSES },
    },
    select: { id: true },
  });
  if (alreadyQueued !== null) return;

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) return;
  const enrichment = lead.enrichment;
  if (enrichment === null) return;
  if (lead.doNotContact) return;

  if (isExcludedFromCold(lead)) {
    await audit('sequencer.excluded', state.coldDraft.id, { leadId });
    return;
  }

  const template = FOLLOWUP_TEMPLATES[state.nextStep];
  if (template === undefined) return;

  const ctx = {
    facility: lead.name,
    googleReviews: lead.googleReviews ?? undefined,
    nextQ: NEXT_QUARTER_PHRASE,
    phone: process.env.SONIA_PHONE,
    signals: enrichment.signals,
    bookingUrl: getBookingLink(),
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
      kind: followupKind,
      subject,
      body,
      status: 'pending',
    },
  });

  await audit('sequencer.drafted', draft.id, {
    leadId,
    step: state.nextStep,
    email: targetEmail,
    dueAt: state.nextSendAt.toISOString(),
  });
};
