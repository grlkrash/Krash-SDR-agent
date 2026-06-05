// Call-first outbound sequence — state derived from AuditLog (PRD: no Sequence table).
//
// Cadence: cold call 1 → voicemail 1 → cold email 1 → cold call 2 (demo book) →
// demo → follow-up. Voicemail is manual (AI vm paused). Cold email drafts after
// vm-1 (or immediately when call 1 connects).

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { businessDay } from '../shared/businessDays.js';
import { createHubspotTask, completeHubspotTask } from '../shared/hubspotTask.js';
import { logHubspotOutboundCall } from '../shared/logHubspotCall.js';
import { logHubspotNote } from '../shared/logHubspotNote.js';
import {
  OUTBOUND_STEP_LABELS,
  OUTBOUND_STEPS,
  type OutboundStep,
  stepIndex,
} from '../shared/outboundSteps.js';
import { getDealStageForLead } from '../shared/hubspotDealStages.js';
import { resolveHubspotCallTarget } from '../shared/hubspotLinks.js';
import { isSmokeTestLeadRecord } from '../shared/smokeTestLead.js';
import { draftColdEmail } from './draftCold.js';
import { callHint, formatPhoneForDisplay } from './brief/shared.js';

const MS_PER_DAY = 86_400_000;
const LOOKBACK_DAYS = 45;
const COLD_CALL_2_BD = 2;
const COLD_KIND = 'cold';
const SENT_STATUSES = ['sent', 'auto-sent'];

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const audit = (
  action: string,
  leadId: string,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'lead', entityId: leadId, meta } });

type TouchMeta = { step?: string; outcome?: string; notes?: string; taskId?: string };

const parseTouchMeta = (meta: unknown): TouchMeta => {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return {};
  return meta as TouchMeta;
};

const isOutboundStep = (raw: string | undefined): raw is OutboundStep =>
  raw !== undefined && (OUTBOUND_STEPS as readonly string[]).includes(raw);

export type OutboundTouch = {
  step: OutboundStep;
  outcome: string;
  notes: string | null;
  at: Date;
};

export type OutboundSequenceState =
  | { status: 'none' }
  | { status: 'completed' }
  | { status: 'active'; currentStep: OutboundStep; touches: OutboundTouch[]; startedAt: Date };

const loadTouches = async (leadId: string): Promise<OutboundTouch[]> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'outbound.touch', entityId: leadId },
    orderBy: { createdAt: 'asc' },
    select: { meta: true, createdAt: true },
  });
  const touches: OutboundTouch[] = [];
  for (const row of rows) {
    const m = parseTouchMeta(row.meta);
    if (!isOutboundStep(m.step)) continue;
    touches.push({
      step: m.step,
      outcome: m.outcome ?? 'logged',
      notes: typeof m.notes === 'string' && m.notes !== '' ? m.notes : null,
      at: row.createdAt,
    });
  }
  return touches;
};

const stepComplete = (touches: OutboundTouch[], step: OutboundStep): boolean => {
  const touch = touches.find((t) => t.step === step);
  if (touch === undefined) return false;
  if (step === 'cold-call-1') {
    return touch.outcome === 'connected' || touch.outcome === 'no-answer';
  }
  if (step === 'voicemail-1') {
    return touch.outcome === 'left' || touch.outcome === 'skipped';
  }
  if (step === 'cold-email') {
    return touch.outcome === 'sent';
  }
  if (step === 'cold-call-2') {
    return touch.outcome === 'connected' || touch.outcome === 'no-answer' || touch.outcome === 'demo-booked';
  }
  if (step === 'demo') {
    return touch.outcome === 'booked' || touch.outcome === 'completed' || touch.outcome === 'no-show';
  }
  if (step === 'follow-up') {
    return touch.outcome === 'done';
  }
  return false;
};

const resolveCurrentStep = (touches: OutboundTouch[]): OutboundStep | 'completed' => {
  if (touches.some((t) => t.step === 'cold-call-1' && t.outcome === 'connected')) {
    // Connected on call 1 — skip voicemail.
    const ordered: OutboundStep[] = ['cold-call-1', 'cold-email', 'cold-call-2', 'demo', 'follow-up'];
    for (const step of ordered) {
      if (!stepComplete(touches, step)) return step;
    }
    return 'completed';
  }

  for (const step of OUTBOUND_STEPS) {
    if (step === 'voicemail-1') {
      const call1 = touches.find((t) => t.step === 'cold-call-1');
      if (call1?.outcome === 'connected') continue;
    }
    if (!stepComplete(touches, step)) return step;
  }
  return 'completed';
};

export const getOutboundSequenceState = async (leadId: string): Promise<OutboundSequenceState> => {
  const started = await prisma.auditLog.findFirst({
    where: { action: 'outbound.sequence-started', entityId: leadId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (started === null) return { status: 'none' };

  const completed = await prisma.auditLog.findFirst({
    where: { action: 'outbound.sequence-completed', entityId: leadId },
    select: { id: true },
  });
  if (completed !== null) return { status: 'completed' };

  const touches = await loadTouches(leadId);
  const current = resolveCurrentStep(touches);
  if (current === 'completed') return { status: 'completed' };
  return { status: 'active', currentStep: current, touches, startedAt: started.createdAt };
};

export const isReadyForColdEmailDraft = async (leadId: string): Promise<boolean> => {
  const state = await getOutboundSequenceState(leadId);
  if (state.status === 'none' || state.status === 'completed') return true;
  if (state.status !== 'active') return false;
  const idx = stepIndex(state.currentStep);
  return idx >= stepIndex('cold-email');
};

export const hasActiveOutboundSequence = async (leadId: string): Promise<boolean> => {
  const state = await getOutboundSequenceState(leadId);
  return state.status === 'active';
};

const taskSubject = (facility: string, step: OutboundStep): string => {
  if (step === 'cold-call-1') return `Outbound call 1 — ${facility}`;
  if (step === 'cold-call-2') return `Demo-book call — ${facility}`;
  return `${OUTBOUND_STEP_LABELS[step]} — ${facility}`;
};

const taskBody = (facility: string, city: string, step: OutboundStep): string =>
  `${OUTBOUND_STEP_LABELS[step]} for ${facility} (${city}). See /outbound for the live cadence.`;

export const startOutboundSequence = async (leadId: string): Promise<void> => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) throw new Error(`Lead not found: ${leadId}`);
  if (lead.doNotContact) throw new Error('Lead is do-not-contact');
  if (lead.phoneE164 === null) throw new Error('Lead has no phone — outbound sequence requires a dial target');
  if (isSmokeTestLeadRecord(lead)) throw new Error('Smoke-test lead — use seed lanes only');

  const existing = await getOutboundSequenceState(leadId);
  if (existing.status === 'active') return;

  const dueAt = new Date();
  const taskId = await createHubspotTask({
    subject: taskSubject(lead.name, 'cold-call-1'),
    body: taskBody(lead.name, lead.city, 'cold-call-1'),
    dueAt,
    companyId: lead.hubspotCompanyId,
    draftId: leadId,
    touchNumber: 1,
  });

  await audit('outbound.sequence-started', leadId, {
    facility: lead.name,
    taskId,
    phoneE164: lead.phoneE164,
  });
  await audit('outbound.task-created', leadId, {
    step: 'cold-call-1',
    taskId,
    dueAt: dueAt.toISOString(),
  });
};

const closeOpenOutboundTasks = async (leadId: string): Promise<void> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'outbound.task-created', entityId: leadId },
    select: { meta: true },
  });
  for (const row of rows) {
    const taskId = parseTouchMeta(row.meta).taskId;
    if (typeof taskId === 'string' && taskId !== '') {
      await completeHubspotTask({ taskId, draftId: leadId });
    }
  }
};

export const completeOutboundSequence = async (leadId: string, reason: string): Promise<void> => {
  const existing = await prisma.auditLog.findFirst({
    where: { action: 'outbound.sequence-completed', entityId: leadId },
  });
  if (existing !== null) return;
  await closeOpenOutboundTasks(leadId);
  await audit('outbound.sequence-completed', leadId, { reason });
};

const maybeDraftColdEmail = async (leadId: string): Promise<string | null> => {
  const pending = await prisma.draft.findFirst({
    where: { leadId, kind: COLD_KIND, status: { in: ['pending', 'approved'] } },
    select: { id: true },
  });
  if (pending !== null) return pending.id;
  return draftColdEmail(leadId);
};

const flagColdCall2 = async (leadId: string): Promise<void> => {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (lead === null || lead.phoneE164 === null) return;

  const coldDraft = await prisma.draft.findFirst({
    where: { leadId, kind: COLD_KIND, status: { in: SENT_STATUSES } },
    orderBy: { sentAt: 'desc' },
    select: { sentAt: true },
  });
  const anchor = coldDraft?.sentAt ?? new Date();
  const dueAt = businessDay(anchor, COLD_CALL_2_BD);

  const existing = await prisma.auditLog.findFirst({
    where: {
      action: 'outbound.task-created',
      entityId: leadId,
      meta: { path: ['step'], equals: 'cold-call-2' },
    },
  });
  if (existing !== null) return;

  const taskId = await createHubspotTask({
    subject: taskSubject(lead.name, 'cold-call-2'),
    body: taskBody(lead.name, lead.city, 'cold-call-2'),
    dueAt,
    companyId: lead.hubspotCompanyId,
    draftId: leadId,
    touchNumber: 2,
  });
  await audit('outbound.task-created', leadId, {
    step: 'cold-call-2',
    taskId,
    dueAt: dueAt.toISOString(),
  });
};

export const logOutboundColdEmailSent = async (leadId: string): Promise<void> => {
  const state = await getOutboundSequenceState(leadId);
  if (state.status !== 'active') return;
  if (stepComplete(state.touches, 'cold-email')) return;

  await audit('outbound.touch', leadId, { step: 'cold-email', outcome: 'sent' });
  await flagColdCall2(leadId);
};

export type LogOutboundTouchResult = { step: OutboundStep; draftId: string | null };

export const logOutboundTouch = async (opts: {
  leadId: string;
  step: OutboundStep;
  outcome: string;
  notes?: string;
}): Promise<LogOutboundTouchResult> => {
  const state = await getOutboundSequenceState(opts.leadId);
  if (state.status !== 'active') {
    throw new Error('No active outbound sequence for this lead');
  }
  if (state.currentStep !== opts.step) {
    throw new Error(`Expected step ${state.currentStep}, got ${opts.step}`);
  }

  const lead = await prisma.lead.findUnique({
    where: { id: opts.leadId },
    include: { enrichment: true },
  });
  if (lead === null) throw new Error('Lead not found');

  const notes = opts.notes?.trim() ?? '';
  await audit('outbound.touch', opts.leadId, {
    step: opts.step,
    outcome: opts.outcome,
    notes: notes !== '' ? notes : undefined,
  });

  if (notes !== '') {
    await logHubspotNote({
      leadId: opts.leadId,
      companyId: lead.hubspotCompanyId,
      body: `[${OUTBOUND_STEP_LABELS[opts.step]}] ${notes}`,
    });
  }

  let draftId: string | null = null;

  if (opts.step === 'cold-call-1' || opts.step === 'cold-call-2') {
    const disposition = opts.outcome === 'connected' ? 'connected' : 'no-answer';
    const coldDraft = await prisma.draft.findFirst({
      where: { leadId: opts.leadId, kind: COLD_KIND },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    await logHubspotOutboundCall({
      draftId: coldDraft?.id ?? opts.leadId,
      companyId: lead.hubspotCompanyId,
      disposition,
    });
  }

  if (opts.step === 'cold-call-1' && opts.outcome === 'connected') {
    draftId = await maybeDraftColdEmail(opts.leadId);
  }

  if (opts.step === 'voicemail-1' && (opts.outcome === 'left' || opts.outcome === 'skipped')) {
    draftId = await maybeDraftColdEmail(opts.leadId);
  }

  if (opts.step === 'cold-call-2' && opts.outcome === 'demo-booked') {
    // Demo booking handled separately via bookDiscoveryMeeting.
  }

  if (opts.step === 'follow-up' && opts.outcome === 'done') {
    await completeOutboundSequence(opts.leadId, 'follow-up-complete');
  }

  return { step: opts.step, draftId };
};

export type OutboundRow = {
  leadId: string;
  facility: string;
  city: string;
  state: string;
  phone: string;
  phoneE164: string;
  ownerName: string | null;
  hint: string;
  currentStep: OutboundStep;
  startedAt: Date;
  hubspotCompanyId: string | null;
  hubspotCallUrl: string | null;
  ownerEmail: string | null;
  dealId: string | null;
  dealStageId: string | null;
  coldDraftPending: boolean;
  coldDraftSent: boolean;
  meetingStartAt: Date | null;
};

export const buildOutboundRows = async (opts?: { limit?: number }): Promise<OutboundRow[]> => {
  const limit = opts?.limit ?? 100;
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * MS_PER_DAY);
  const started = await prisma.auditLog.findMany({
    where: {
      action: 'outbound.sequence-started',
      createdAt: { gte: cutoff },
    },
    orderBy: { createdAt: 'desc' },
    take: limit * 2,
    select: { entityId: true, createdAt: true },
  });

  const rows: OutboundRow[] = [];
  const seen = new Set<string>();

  for (const s of started) {
    if (s.entityId === null || seen.has(s.entityId)) continue;
    const leadId = s.entityId;
    const state = await getOutboundSequenceState(leadId);
    if (state.status !== 'active') continue;

    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      include: { enrichment: true },
    });
    if (lead === null || lead.phoneE164 === null) continue;
    if (isSmokeTestLeadRecord(lead)) continue;

    const [coldPending, coldSent, meetingRow] = await Promise.all([
      prisma.draft.findFirst({
        where: { leadId, kind: COLD_KIND, status: { in: ['pending', 'approved'] } },
        select: { id: true },
      }),
      prisma.draft.findFirst({
        where: { leadId, kind: COLD_KIND, status: { in: SENT_STATUSES } },
        select: { id: true },
      }),
      prisma.auditLog.findFirst({
        where: {
          action: 'outbound.demo-booked',
          entityId: leadId,
        },
        orderBy: { createdAt: 'desc' },
        select: { meta: true },
      }),
    ]);

    let meetingStartAt: Date | null = null;
    const meetingMeta = meetingRow?.meta;
    if (meetingMeta !== null && meetingMeta !== undefined && typeof meetingMeta === 'object' && !Array.isArray(meetingMeta)) {
      const raw = (meetingMeta as { startAt?: unknown }).startAt;
      if (typeof raw === 'string') {
        const parsed = Date.parse(raw);
        if (!Number.isNaN(parsed)) meetingStartAt = new Date(parsed);
      }
    }

    const ownerEmail = lead.enrichment?.ownerEmail ?? null;
    const [callTarget, dealInfo] = await Promise.all([
      resolveHubspotCallTarget({
        companyId: lead.hubspotCompanyId,
        ownerEmail,
      }),
      getDealStageForLead({ leadId, companyId: lead.hubspotCompanyId }),
    ]);

    seen.add(leadId);
    rows.push({
      leadId,
      facility: lead.name,
      city: lead.city,
      state: lead.state,
      phone: formatPhoneForDisplay(lead.phoneE164),
      phoneE164: lead.phoneE164,
      ownerName: lead.enrichment?.ownerName ?? null,
      hint: callHint(lead.state),
      currentStep: state.currentStep,
      startedAt: s.createdAt,
      hubspotCompanyId: lead.hubspotCompanyId,
      hubspotCallUrl: callTarget?.url ?? null,
      ownerEmail,
      dealId: dealInfo.dealId,
      dealStageId: dealInfo.stageId,
      coldDraftPending: coldPending !== null,
      coldDraftSent: coldSent !== null,
      meetingStartAt,
    });
    if (rows.length >= limit) break;
  }
  return rows;
};

export const countActiveOutboundSequences = async (): Promise<number> => {
  const rows = await buildOutboundRows({ limit: 500 });
  return rows.length;
};

export type StartCandidate = {
  leadId: string;
  facility: string;
  city: string;
  state: string;
  phone: string;
  phoneE164: string;
  ownerName: string | null;
};

export const buildOutboundStartCandidates = async (opts?: { limit?: number }): Promise<StartCandidate[]> => {
  const limit = opts?.limit ?? 15;
  const leads = await prisma.lead.findMany({
    where: {
      doNotContact: false,
      phoneE164: { not: null },
      enrichment: { isNot: null },
    },
    include: { enrichment: true },
    orderBy: { createdAt: 'desc' },
    take: limit * 4,
  });

  const candidates: StartCandidate[] = [];
  for (const lead of leads) {
    if (lead.phoneE164 === null || lead.enrichment === null) continue;
    if (isSmokeTestLeadRecord(lead)) continue;
    const state = await getOutboundSequenceState(lead.id);
    if (state.status !== 'none') continue;
    candidates.push({
      leadId: lead.id,
      facility: lead.name,
      city: lead.city,
      state: lead.state,
      phone: formatPhoneForDisplay(lead.phoneE164),
      phoneE164: lead.phoneE164,
      ownerName: lead.enrichment.ownerName,
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
};
