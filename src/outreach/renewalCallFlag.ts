// Flags sent renewal emails for a 7-business-day call cadence (5 touches on BD 3–7).
// HubSpot tasks + AuditLog track progress; /renewals-call and the daily brief surface open items.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { completeHubspotTask, createHubspotTask } from '../shared/hubspotTask.js';
import { logHubspotOutboundCall } from '../shared/logHubspotCall.js';
import {
  RENEWAL_MAX_TOUCHES,
  type RenewalTouchNumber,
  isWithinRenewalCallWindow,
  nextPendingTouch,
  renewalCallWindowEnd,
  touchDueAt,
} from '../shared/renewalCallTouches.js';
import { callHint, formatPhoneForDisplay } from './brief/shared.js';

const LOOKBACK_DAYS = 45;
const MS_PER_DAY = 86_400_000;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const audit = (
  action: string,
  draftId: string,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'Draft', entityId: draftId, meta } });

type TouchMeta = { touchNumber?: number; hubspotTaskId?: string };
type TaskMeta = { touchNumber?: number; taskId?: string };

const parseTouchNumber = (meta: unknown): number | null => {
  if (meta === null || typeof meta !== 'object') return null;
  const n = Number((meta as TouchMeta).touchNumber);
  return Number.isInteger(n) && n >= 1 && n <= RENEWAL_MAX_TOUCHES ? n : null;
};

const parseTaskId = (meta: unknown): string | null => {
  if (meta === null || typeof meta !== 'object') return null;
  const id = (meta as TaskMeta).taskId;
  return typeof id === 'string' && id !== '' ? id : null;
};

const taskBody = (facility: string, touchNumber: RenewalTouchNumber): string =>
  `Renewal call touch ${String(touchNumber)} of ${String(RENEWAL_MAX_TOUCHES)} for ${facility}. `
  + 'Confirm next contract period — pricing and terms belong on this live call.';

const taskSubject = (facility: string, touchNumber: RenewalTouchNumber): string =>
  `Renewal call ${String(touchNumber)}/${String(RENEWAL_MAX_TOUCHES)} — ${facility}`;

export const flagRenewalForCall = async (draftId: string): Promise<void> => {
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    include: { lead: { include: { enrichment: true } } },
  });
  if (draft === null || draft.kind !== 'renewal') return;
  if (draft.sentAt === null) return;

  const existing = await prisma.auditLog.findFirst({
    where: { action: 'renewal.call-flagged', entityId: draftId },
  });
  if (existing !== null) return;

  const sentAt = draft.sentAt;
  const lead = draft.lead;
  const dueAt = touchDueAt(sentAt, 1);
  const taskId = await createHubspotTask({
    subject: taskSubject(lead.name, 1),
    body: taskBody(lead.name, 1),
    dueAt,
    companyId: lead.hubspotCompanyId,
    draftId,
    touchNumber: 1,
  });

  await audit('renewal.call-flagged', draftId, {
    leadId: lead.id,
    sentAt: sentAt.toISOString(),
    windowEndAt: renewalCallWindowEnd(sentAt).toISOString(),
    firstTaskId: taskId,
    firstTaskDueAt: dueAt.toISOString(),
  });
  await audit('renewal.call-task-created', draftId, {
    touchNumber: 1,
    taskId,
    dueAt: dueAt.toISOString(),
  });
};

const loadTouchState = async (draftIds: string[]): Promise<Map<string, Set<number>>> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'renewal.call-touch', entityId: { in: draftIds } },
    select: { entityId: true, meta: true },
  });
  const map = new Map<string, Set<number>>();
  for (const row of rows) {
    const n = parseTouchNumber(row.meta);
    if (n === null || row.entityId === null) continue;
    const set = map.get(row.entityId) ?? new Set<number>();
    set.add(n);
    map.set(row.entityId, set);
  }
  return map;
};

const loadCompletedDraftIds = async (draftIds: string[]): Promise<Set<string>> => {
  const rows = await prisma.auditLog.findMany({
    where: {
      action: { in: ['renewal.call-completed', 'renewal.call-expired'] },
      entityId: { in: draftIds },
    },
    select: { entityId: true },
  });
  return new Set(rows.map((r) => r.entityId).filter((id): id is string => id !== null));
};

const loadFlaggedDraftIds = async (draftIds: string[]): Promise<Set<string>> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'renewal.call-flagged', entityId: { in: draftIds } },
    select: { entityId: true },
  });
  return new Set(rows.map((r) => r.entityId).filter((id): id is string => id !== null));
};

const loadTasksCreated = async (draftId: string): Promise<Set<number>> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'renewal.call-task-created', entityId: draftId },
    select: { meta: true },
  });
  const set = new Set<number>();
  for (const row of rows) {
    const n = parseTouchNumber(row.meta);
    if (n !== null) set.add(n);
  }
  return set;
};

export type RenewalCallRow = {
  draftId: string;
  facility: string;
  city: string;
  state: string;
  phone: string;
  phoneE164: string;
  ownerName: string | null;
  hint: string;
  sentAt: Date;
  windowEndAt: Date;
  touchesDone: number;
  nextTouchNumber: RenewalTouchNumber | null;
  nextTouchDueAt: Date | null;
  hubspotCompanyId: string | null;
};

export const buildRenewalCallRows = async (opts?: {
  limit?: number;
}): Promise<RenewalCallRow[]> => {
  const limit = opts?.limit ?? 100;
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * MS_PER_DAY);
  const drafts = await prisma.draft.findMany({
    where: {
      kind: 'renewal',
      status: { in: ['sent', 'auto-sent'] },
      sentAt: { gte: cutoff },
    },
    orderBy: { sentAt: 'desc' },
    take: limit * 3,
    include: { lead: { include: { enrichment: true } } },
  });
  const draftIds = drafts.map((d) => d.id);
  if (draftIds.length === 0) return [];

  const [flagged, completed, touchState] = await Promise.all([
    loadFlaggedDraftIds(draftIds),
    loadCompletedDraftIds(draftIds),
    loadTouchState(draftIds),
  ]);

  const now = new Date();
  const rows: RenewalCallRow[] = [];
  const seenLeadIds = new Set<string>();
  for (const d of drafts) {
    if (!flagged.has(d.id) || completed.has(d.id)) continue;
    if (d.sentAt === null) continue;
    if (!isWithinRenewalCallWindow(d.sentAt, now)) continue;
    const lead = d.lead;
    if (lead.phoneE164 === null) continue;
    if (seenLeadIds.has(lead.id)) continue;
    seenLeadIds.add(lead.id);

    const done = touchState.get(d.id) ?? new Set<number>();
    const next = nextPendingTouch(d.sentAt, done, now);
    rows.push({
      draftId: d.id,
      facility: lead.name,
      city: lead.city,
      state: lead.state,
      phone: formatPhoneForDisplay(lead.phoneE164),
      phoneE164: lead.phoneE164,
      ownerName: lead.enrichment?.ownerName ?? null,
      hint: callHint(lead.state),
      sentAt: d.sentAt,
      windowEndAt: renewalCallWindowEnd(d.sentAt),
      touchesDone: done.size,
      nextTouchNumber: next?.touchNumber ?? null,
      nextTouchDueAt: next?.dueAt ?? null,
      hubspotCompanyId: lead.hubspotCompanyId,
    });
    if (rows.length >= limit) break;
  }
  return rows;
};

export const countOpenRenewalCalls = async (): Promise<number> => {
  const rows = await buildRenewalCallRows({ limit: 500 });
  return rows.length;
};

export const logRenewalCallTouch = async (opts: {
  draftId: string;
  outcome: 'connected' | 'no-answer';
}): Promise<{ touchNumber: RenewalTouchNumber | null; completed: boolean }> => {
  const draft = await prisma.draft.findUnique({
    where: { id: opts.draftId },
    include: { lead: true },
  });
  if (draft === null || draft.sentAt === null) return { touchNumber: null, completed: false };

  const done = await loadTouchState([opts.draftId]);
  const completedTouches = done.get(opts.draftId) ?? new Set<number>();
  const next = nextPendingTouch(draft.sentAt, completedTouches, new Date());
  if (next === null) return { touchNumber: null, completed: false };

  const touchNumber = next.touchNumber;
  const taskRow = await prisma.auditLog.findFirst({
    where: {
      action: 'renewal.call-task-created',
      entityId: opts.draftId,
      meta: { path: ['touchNumber'], equals: touchNumber },
    },
    orderBy: { createdAt: 'desc' },
  });
  const taskId = parseTaskId(taskRow?.meta ?? null);

  await audit('renewal.call-touch', opts.draftId, {
    leadId: draft.leadId,
    touchNumber,
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
    await completeRenewalCall(opts.draftId, 'connected-on-touch');
    return { touchNumber, completed: true };
  }

  return { touchNumber, completed: false };
};

export const completeRenewalCall = async (
  draftId: string,
  reason: string,
): Promise<void> => {
  const existing = await prisma.auditLog.findFirst({
    where: { action: 'renewal.call-completed', entityId: draftId },
  });
  if (existing !== null) return;

  const taskRows = await prisma.auditLog.findMany({
    where: { action: 'renewal.call-task-created', entityId: draftId },
    select: { meta: true },
  });
  for (const row of taskRows) {
    const taskId = parseTaskId(row.meta);
    if (taskId !== null) {
      await completeHubspotTask({ taskId, draftId });
    }
  }

  await audit('renewal.call-completed', draftId, { reason });
};

export const runRenewalCallFollowups = async (): Promise<void> => {
  const now = new Date();
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * MS_PER_DAY);
  const drafts = await prisma.draft.findMany({
    where: {
      kind: 'renewal',
      status: { in: ['sent', 'auto-sent'] },
      sentAt: { gte: cutoff },
    },
    include: { lead: true },
  });
  const draftIds = drafts.map((d) => d.id);
  if (draftIds.length === 0) return;

  const [flagged, completed, touchState] = await Promise.all([
    loadFlaggedDraftIds(draftIds),
    loadCompletedDraftIds(draftIds),
    loadTouchState(draftIds),
  ]);

  let tasksCreated = 0;
  let expired = 0;

  for (const draft of drafts) {
    if (!flagged.has(draft.id) || completed.has(draft.id)) continue;
    if (draft.sentAt === null) continue;

    if (!isWithinRenewalCallWindow(draft.sentAt, now)) {
      const alreadyExpired = await prisma.auditLog.findFirst({
        where: { action: 'renewal.call-expired', entityId: draft.id },
      });
      if (alreadyExpired === null) {
        await audit('renewal.call-expired', draft.id, {
          leadId: draft.leadId,
          sentAt: draft.sentAt.toISOString(),
        });
        expired += 1;
      }
      continue;
    }

    const done = touchState.get(draft.id) ?? new Set<number>();
    const tasksForDraft = await loadTasksCreated(draft.id);

    for (let i = 1; i <= RENEWAL_MAX_TOUCHES; i += 1) {
      const touchNumber = i as RenewalTouchNumber;
      if (done.has(touchNumber) || tasksForDraft.has(touchNumber)) continue;
      const dueAt = touchDueAt(draft.sentAt, touchNumber);
      if (startOfUtcDay(now).getTime() < startOfUtcDay(dueAt).getTime()) continue;

      const taskId = await createHubspotTask({
        subject: taskSubject(draft.lead.name, touchNumber),
        body: taskBody(draft.lead.name, touchNumber),
        dueAt,
        companyId: draft.lead.hubspotCompanyId,
        draftId: draft.id,
        touchNumber,
      });
      await audit('renewal.call-task-created', draft.id, {
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
      entity: 'renewalCallFollowups',
      meta: { tasksCreated, expired, checked: drafts.length },
    },
  });
};

const startOfUtcDay = (d: Date): Date =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
