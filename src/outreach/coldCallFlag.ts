// Interleaves a 3-touch human call cadence into the cold email sequence. Their
// best-performing sequences pair email with phone, so when a cold email is sent
// to a prospect with a phone on file we open a call sequence: touch 1 fires now
// (HubSpot task due BD 2), and runColdCallFollowups creates touches 2 (BD 5) and
// 3 (BD 9) as they come due.
//
// No web UI (the HubSpot task is the system of record): the daily brief "Cold
// calls to make" section shows any prospect with an open (not-completed) cold
// call task. The whole sequence is retired — open tasks closed — once the lead
// replies, books a meeting, or the BD-9 window expires.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { hs, hsRetry } from '../shared/hubspot.js';
import { completeHubspotTask, createHubspotTask } from '../shared/hubspotTask.js';
import { logHubspotOutboundCall } from '../shared/logHubspotCall.js';
import {
  COLD_CALL_MAX_TOUCHES,
  type ColdCallTouchNumber,
  coldCallWindowEnd,
  coldTouchDueAt,
  isWithinColdCallWindow,
} from '../shared/coldCallTouches.js';
import { isSmokeTestLeadRecord } from '../shared/smokeTestLead.js';
import { callHint, formatPhoneForDisplay } from './brief/shared.js';

const MS_PER_DAY = 86_400_000;
const LOOKBACK_DAYS = 21;
const HUBSPOT_TASK_COMPLETED = 'COMPLETED';
const REPLIED_KIND = 'replied';
const COLD_KIND = 'cold';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const audit = (
  action: string,
  draftId: string,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'Draft', entityId: draftId, meta } });

const taskSubject = (facility: string, touchNumber: ColdCallTouchNumber): string =>
  `Cold call ${String(touchNumber)}/${String(COLD_CALL_MAX_TOUCHES)} — ${facility}`;

const taskBody = (
  facility: string,
  city: string,
  touchNumber: ColdCallTouchNumber,
): string =>
  `Cold call touch ${String(touchNumber)} of ${String(COLD_CALL_MAX_TOUCHES)} for ${facility} (${city}). `
  + 'Pair the cold email with a live call: lead with the free Sobriety Select profile '
  + 'and offer a quick walkthrough. Keep any paid tier for the booked call.';

type TaskMeta = { touchNumber?: number; taskId?: string };

const parseTouchNumber = (meta: unknown): number | null => {
  if (meta === null || typeof meta !== 'object') return null;
  const n = Number((meta as TaskMeta).touchNumber);
  return Number.isInteger(n) && n >= 1 && n <= COLD_CALL_MAX_TOUCHES ? n : null;
};

const parseTaskId = (meta: unknown): string | null => {
  if (meta === null || typeof meta !== 'object') return null;
  const id = (meta as TaskMeta).taskId;
  return typeof id === 'string' && id !== '' ? id : null;
};

// --- send-time entry point -------------------------------------------------

export const flagColdForCall = async (draftId: string): Promise<void> => {
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    include: { lead: { include: { enrichment: true } } },
  });
  if (draft === null || draft.kind !== COLD_KIND) return;
  if (draft.sentAt === null) return;

  const lead = draft.lead;
  // No phone on file means nothing to call — the email stands on its own.
  if (lead.phoneE164 === null) return;

  const existing = await prisma.auditLog.findFirst({
    where: { action: 'cold.call-flagged', entityId: draftId },
  });
  if (existing !== null) return;

  const sentAt = draft.sentAt;
  const firstTouch: ColdCallTouchNumber = 1;
  const dueAt = coldTouchDueAt(sentAt, firstTouch);
  const taskId = await createHubspotTask({
    subject: taskSubject(lead.name, firstTouch),
    body: taskBody(lead.name, lead.city, firstTouch),
    dueAt,
    companyId: lead.hubspotCompanyId,
    draftId,
    touchNumber: firstTouch,
  });

  await audit('cold.call-flagged', draftId, {
    leadId: lead.id,
    sentAt: sentAt.toISOString(),
    windowEndAt: coldCallWindowEnd(sentAt).toISOString(),
    firstTaskId: taskId,
    firstTaskDueAt: dueAt.toISOString(),
  });
  await audit('cold.call-task-created', draftId, {
    touchNumber: firstTouch,
    taskId,
    dueAt: dueAt.toISOString(),
  });
};

// --- shared loaders --------------------------------------------------------

const loadFlaggedDraftIds = async (draftIds: string[]): Promise<Set<string>> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'cold.call-flagged', entityId: { in: draftIds } },
    select: { entityId: true },
  });
  return new Set(rows.map((r) => r.entityId).filter((id): id is string => id !== null));
};

const loadRetiredDraftIds = async (draftIds: string[]): Promise<Set<string>> => {
  const rows = await prisma.auditLog.findMany({
    where: {
      action: { in: ['cold.call-completed', 'cold.call-expired'] },
      entityId: { in: draftIds },
    },
    select: { entityId: true },
  });
  return new Set(rows.map((r) => r.entityId).filter((id): id is string => id !== null));
};

type CreatedTask = { touchNumber: number; taskId: string | null };

const loadCreatedTasksByDraft = async (
  draftIds: string[],
): Promise<Map<string, CreatedTask[]>> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'cold.call-task-created', entityId: { in: draftIds } },
    select: { entityId: true, meta: true },
  });
  const map = new Map<string, CreatedTask[]>();
  for (const r of rows) {
    if (r.entityId === null) continue;
    const touchNumber = parseTouchNumber(r.meta);
    if (touchNumber === null) continue;
    const arr = map.get(r.entityId) ?? [];
    arr.push({ touchNumber, taskId: parseTaskId(r.meta) });
    map.set(r.entityId, arr);
  }
  return map;
};

// Touches logged from the /cold-call page (connected / no-answer), per draft.
// Complements HubSpot task completion: a touch counts as done if it was logged
// in our UI OR its HubSpot task was closed directly in HubSpot.
const loadTouchStateByDraft = async (
  draftIds: string[],
): Promise<Map<string, Set<number>>> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'cold.call-touch', entityId: { in: draftIds } },
    select: { entityId: true, meta: true },
  });
  const map = new Map<string, Set<number>>();
  for (const r of rows) {
    if (r.entityId === null) continue;
    const n = parseTouchNumber(r.meta);
    if (n === null) continue;
    const set = map.get(r.entityId) ?? new Set<number>();
    set.add(n);
    map.set(r.entityId, set);
  }
  return map;
};

// Inbound replies per lead. A reply at/after the cold send means they engaged —
// switch to the reply lane, not a cold dial.
const loadRepliedAtByLead = async (leadIds: string[]): Promise<Map<string, Date[]>> => {
  if (leadIds.length === 0) return new Map();
  const rows = await prisma.draft.findMany({
    where: { leadId: { in: leadIds }, kind: REPLIED_KIND },
    select: { leadId: true, createdAt: true },
  });
  const map = new Map<string, Date[]>();
  for (const r of rows) {
    const arr = map.get(r.leadId) ?? [];
    arr.push(r.createdAt);
    map.set(r.leadId, arr);
  }
  return map;
};

// Leads that already booked a meeting (meeting.booked audit from attribution).
const loadBookedLeadIds = async (leadIds: string[]): Promise<Set<string>> => {
  if (leadIds.length === 0) return new Set();
  const rows = await prisma.auditLog.findMany({
    where: { action: 'meeting.booked' },
    select: { meta: true },
  });
  const wanted = new Set(leadIds);
  const booked = new Set<string>();
  for (const r of rows) {
    const meta = r.meta;
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) continue;
    const leadId = (meta as { leadId?: unknown }).leadId;
    if (typeof leadId === 'string' && wanted.has(leadId)) booked.add(leadId);
  }
  return booked;
};

const loadCompletedTaskIds = async (taskIds: string[]): Promise<Set<string>> => {
  const completed = new Set<string>();
  for (const taskId of taskIds) {
    try {
      const task = await hsRetry(() =>
        hs.crm.objects.tasks.basicApi.getById(taskId, ['hs_task_status']),
      );
      if (task.properties?.hs_task_status === HUBSPOT_TASK_COMPLETED) {
        completed.add(taskId);
      }
    } catch {
      // ignore — treat as not completed
    }
  }
  return completed;
};

const repliedAfter = (replies: Date[] | undefined, sinceMs: number): boolean =>
  (replies ?? []).some((t) => t.getTime() >= sinceMs);

// Close any open (created) HubSpot call tasks and retire the sequence. Used when
// a lead replies, books, or the window expires.
export const completeColdCall = async (draftId: string, reason: string): Promise<void> => {
  const existing = await prisma.auditLog.findFirst({
    where: { action: { in: ['cold.call-completed', 'cold.call-expired'] }, entityId: draftId },
  });
  if (existing !== null) return;

  const created = await loadCreatedTasksByDraft([draftId]);
  for (const t of created.get(draftId) ?? []) {
    if (t.taskId !== null) await completeHubspotTask({ taskId: t.taskId, draftId });
  }
  await audit('cold.call-completed', draftId, { reason });
};

// Log one call attempt from the /cold-call page: records the disposition
// (connected / no-answer) for system-improvement data, logs a HubSpot outbound
// call engagement, and closes that touch's HubSpot task. A "connected" outcome
// retires the whole sequence.
export const logColdCallTouch = async (opts: {
  draftId: string;
  touchNumber: number;
  outcome: 'connected' | 'no-answer';
}): Promise<{ touchNumber: number | null; completed: boolean }> => {
  const draft = await prisma.draft.findUnique({
    where: { id: opts.draftId },
    include: { lead: true },
  });
  if (draft === null || draft.kind !== COLD_KIND) {
    return { touchNumber: null, completed: false };
  }

  // Idempotent: ignore a double-submit for the same touch.
  const existing = await prisma.auditLog.findFirst({
    where: {
      action: 'cold.call-touch',
      entityId: opts.draftId,
      meta: { path: ['touchNumber'], equals: opts.touchNumber },
    },
  });
  if (existing !== null) {
    return { touchNumber: opts.touchNumber, completed: false };
  }

  const created = await loadCreatedTasksByDraft([opts.draftId]);
  const task = (created.get(opts.draftId) ?? []).find((t) => t.touchNumber === opts.touchNumber);
  const taskId = task?.taskId ?? null;

  await audit('cold.call-touch', opts.draftId, {
    leadId: draft.leadId,
    touchNumber: opts.touchNumber,
    outcome: opts.outcome,
    hubspotTaskId: taskId,
  });

  await logHubspotOutboundCall({
    draftId: opts.draftId,
    companyId: draft.lead.hubspotCompanyId,
    disposition: opts.outcome === 'connected' ? 'connected' : 'no-answer',
  });

  if (taskId !== null) {
    await completeHubspotTask({ taskId, draftId: opts.draftId });
  }

  if (opts.outcome === 'connected') {
    await completeColdCall(opts.draftId, 'connected-on-touch');
    return { touchNumber: opts.touchNumber, completed: true };
  }
  return { touchNumber: opts.touchNumber, completed: false };
};

// --- daily brief -----------------------------------------------------------

export type ColdCallRow = {
  draftId: string;
  leadId: string;
  facility: string;
  city: string;
  state: string;
  phone: string;
  phoneE164: string;
  ownerName: string | null;
  hint: string;
  sentAt: Date;
  windowEndAt: Date;
  hubspotCompanyId: string | null;
  touchesDone: number;
  nextTouchNumber: number | null;
};

export const buildColdCallRows = async (opts?: {
  limit?: number;
}): Promise<ColdCallRow[]> => {
  const limit = opts?.limit ?? 100;
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * MS_PER_DAY);
  const drafts = await prisma.draft.findMany({
    where: {
      kind: COLD_KIND,
      status: { in: ['sent', 'auto-sent'] },
      sentAt: { gte: cutoff },
    },
    orderBy: { sentAt: 'desc' },
    take: limit * 3,
    include: { lead: { include: { enrichment: true } } },
  });
  const draftIds = drafts.map((d) => d.id);
  if (draftIds.length === 0) return [];

  const now = new Date();
  const [flagged, retired] = await Promise.all([
    loadFlaggedDraftIds(draftIds),
    loadRetiredDraftIds(draftIds),
  ]);

  // First pass: flagged, not retired, within window, has phone, deduped by lead,
  // not replied since the send, not booked. Defer HubSpot task-status lookups to
  // this narrowed set.
  const flaggedLeadIds = [
    ...new Set(drafts.filter((d) => flagged.has(d.id)).map((d) => d.lead.id)),
  ];
  const [repliedByLead, bookedLeadIds] = await Promise.all([
    loadRepliedAtByLead(flaggedLeadIds),
    loadBookedLeadIds(flaggedLeadIds),
  ]);

  type Candidate = { draft: (typeof drafts)[number] };
  const candidates: Candidate[] = [];
  const seenLeadIds = new Set<string>();
  for (const d of drafts) {
    const lead = d.lead;
    // Smoke-test lanes are operator inbox validation — never show in call queues.
    if (isSmokeTestLeadRecord(lead)) {
      if (flagged.has(d.id) && !retired.has(d.id)) {
        await completeColdCall(d.id, 'smoke-test-retired');
      }
      continue;
    }
    if (!flagged.has(d.id) || retired.has(d.id) || d.sentAt === null) continue;
    if (!isWithinColdCallWindow(d.sentAt, now)) continue;
    if (lead.phoneE164 === null) continue;
    if (seenLeadIds.has(lead.id)) continue;
    if (bookedLeadIds.has(lead.id)) continue;
    if (repliedAfter(repliedByLead.get(lead.id), d.sentAt.getTime())) continue;
    seenLeadIds.add(lead.id);
    candidates.push({ draft: d });
  }
  if (candidates.length === 0) return [];

  const candidateIds = candidates.map((c) => c.draft.id);
  const [createdByDraft, touchStateByDraft] = await Promise.all([
    loadCreatedTasksByDraft(candidateIds),
    loadTouchStateByDraft(candidateIds),
  ]);

  // Only HubSpot-check tasks for touches not already logged done in our UI.
  const taskIdsToCheck: string[] = [];
  for (const [draftId, tasks] of createdByDraft) {
    const uiDone = touchStateByDraft.get(draftId) ?? new Set<number>();
    for (const t of tasks) {
      if (t.taskId !== null && !uiDone.has(t.touchNumber)) taskIdsToCheck.push(t.taskId);
    }
  }
  const completedTaskIds = await loadCompletedTaskIds(taskIdsToCheck);

  const rows: ColdCallRow[] = [];
  for (const c of candidates) {
    const d = c.draft;
    const lead = d.lead;
    if (d.sentAt === null || lead.phoneE164 === null) continue;

    const created = createdByDraft.get(d.id) ?? [];
    const uiDone = touchStateByDraft.get(d.id) ?? new Set<number>();
    // A touch is done if logged in our UI OR its HubSpot task was closed.
    const outstanding = created
      .filter((t) =>
        !uiDone.has(t.touchNumber)
        && (t.taskId === null || !completedTaskIds.has(t.taskId)))
      .map((t) => t.touchNumber)
      .sort((a, b) => a - b);
    // No open call task right now (cron will create the next touch when due).
    if (outstanding.length === 0) continue;
    const touchesDone = created.length - outstanding.length;

    rows.push({
      draftId: d.id,
      leadId: lead.id,
      facility: lead.name,
      city: lead.city,
      state: lead.state,
      phone: formatPhoneForDisplay(lead.phoneE164),
      phoneE164: lead.phoneE164,
      ownerName: lead.enrichment?.ownerName ?? null,
      hint: callHint(lead.state),
      sentAt: d.sentAt,
      windowEndAt: coldCallWindowEnd(d.sentAt),
      hubspotCompanyId: lead.hubspotCompanyId,
      touchesDone,
      nextTouchNumber: outstanding[0] ?? null,
    });
    if (rows.length >= limit) break;
  }
  return rows;
};

export const countOpenColdCalls = async (): Promise<number> => {
  const rows = await buildColdCallRows({ limit: 500 });
  return rows.length;
};

// --- daily follow-up cron --------------------------------------------------

export const runColdCallFollowups = async (): Promise<void> => {
  const now = new Date();
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * MS_PER_DAY);
  const drafts = await prisma.draft.findMany({
    where: {
      kind: COLD_KIND,
      status: { in: ['sent', 'auto-sent'] },
      sentAt: { gte: cutoff },
    },
    include: { lead: true },
  });
  const draftIds = drafts.map((d) => d.id);
  if (draftIds.length === 0) return;

  const [flagged, retired, createdByDraft] = await Promise.all([
    loadFlaggedDraftIds(draftIds),
    loadRetiredDraftIds(draftIds),
    loadCreatedTasksByDraft(draftIds),
  ]);
  const leadIds = [...new Set(drafts.map((d) => d.leadId))];
  const [repliedByLead, bookedLeadIds] = await Promise.all([
    loadRepliedAtByLead(leadIds),
    loadBookedLeadIds(leadIds),
  ]);

  let tasksCreated = 0;
  let expired = 0;
  let retiredCount = 0;

  for (const draft of drafts) {
    if (isSmokeTestLeadRecord(draft.lead)) {
      if (flagged.has(draft.id) && !retired.has(draft.id)) {
        await completeColdCall(draft.id, 'smoke-test-retired');
      }
      continue;
    }
    if (!flagged.has(draft.id) || retired.has(draft.id) || draft.sentAt === null) continue;

    // Lead re-engaged or booked → retire the sequence and close open tasks.
    const reEngaged = repliedAfter(repliedByLead.get(draft.leadId), draft.sentAt.getTime());
    if (reEngaged || bookedLeadIds.has(draft.leadId)) {
      await completeColdCall(draft.id, reEngaged ? 'lead-replied' : 'meeting-booked');
      retiredCount += 1;
      continue;
    }

    if (!isWithinColdCallWindow(draft.sentAt, now)) {
      await audit('cold.call-expired', draft.id, {
        leadId: draft.leadId,
        sentAt: draft.sentAt.toISOString(),
      });
      expired += 1;
      continue;
    }

    const createdNumbers = new Set(
      (createdByDraft.get(draft.id) ?? []).map((t) => t.touchNumber),
    );
    for (let i = 1; i <= COLD_CALL_MAX_TOUCHES; i += 1) {
      const touchNumber = i as ColdCallTouchNumber;
      if (createdNumbers.has(touchNumber)) continue;
      const dueAt = coldTouchDueAt(draft.sentAt, touchNumber);
      if (startOfUtcDay(now).getTime() < startOfUtcDay(dueAt).getTime()) continue;

      const taskId = await createHubspotTask({
        subject: taskSubject(draft.lead.name, touchNumber),
        body: taskBody(draft.lead.name, draft.lead.city, touchNumber),
        dueAt,
        companyId: draft.lead.hubspotCompanyId,
        draftId: draft.id,
        touchNumber,
      });
      await audit('cold.call-task-created', draft.id, {
        touchNumber,
        taskId,
        dueAt: dueAt.toISOString(),
      });
      tasksCreated += 1;
    }
  }

  await prisma.auditLog.create({
    data: {
      action: 'cron.success',
      entity: 'coldCallFollowups',
      meta: { tasksCreated, expired, retired: retiredCount, checked: drafts.length },
    },
  });
};

const startOfUtcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
