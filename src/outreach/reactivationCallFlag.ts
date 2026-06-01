// Flags sent reactivation emails for a manual call. Voicemail is paused, so a
// reactivation that used to trigger an AI voicemail now creates one HubSpot
// call task and surfaces in the daily brief "Reactivations to call" section.
//
// Deliberately leaner than the renewal call lane: a single touch, no multi-day
// cadence and no web UI. Items age out of the 14-day window automatically;
// the HubSpot task is the system of record for working the call.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { hs, hsRetry } from '../shared/hubspot.js';
import { createHubspotTask } from '../shared/hubspotTask.js';
import { callHint, formatPhoneForDisplay } from './brief/shared.js';

const MS_PER_DAY = 86_400_000;
const REACTIVATION_CALL_WINDOW_DAYS = 14;
const FIRST_TOUCH_DELAY_DAYS = 1;
const FIRST_TOUCH_NUMBER = 1;
const HUBSPOT_TASK_COMPLETED = 'COMPLETED';
const REPLIED_KIND = 'replied';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const audit = (
  action: string,
  draftId: string,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'Draft', entityId: draftId, meta } });

const taskSubject = (facility: string): string => `Reactivation call — ${facility}`;

const taskBody = (facility: string): string =>
  `Reactivation email sent to ${facility}. Give them a live call to re-open the `
  + 'conversation — voicemail is paused, so this is a manual touch.';

type FlagMeta = { taskId?: string | null };

const parseTaskId = (meta: unknown): string | null => {
  if (meta === null || typeof meta !== 'object') return null;
  const id = (meta as FlagMeta).taskId;
  return typeof id === 'string' && id !== '' ? id : null;
};

// Map flagged draft → its HubSpot call task id (null if task creation failed).
const loadFlaggedTaskByDraft = async (
  draftIds: string[],
): Promise<Map<string, string | null>> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'reactivation.call-flagged', entityId: { in: draftIds } },
    select: { entityId: true, meta: true },
  });
  const map = new Map<string, string | null>();
  for (const r of rows) {
    if (r.entityId === null || map.has(r.entityId)) continue;
    map.set(r.entityId, parseTaskId(r.meta));
  }
  return map;
};

// Inbound replies per lead. A reply dated after the reactivation send means the
// lead re-engaged, so the manual call is no longer needed.
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

// Which of these HubSpot tasks are marked COMPLETED. On lookup failure we leave
// the task out of the set (keep showing the call) — over-surfacing a call beats
// silently dropping one.
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

export const flagReactivationForCall = async (draftId: string): Promise<void> => {
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    include: { lead: { include: { enrichment: true } } },
  });
  if (draft === null || draft.kind !== 'reactivation') return;
  if (draft.sentAt === null) return;

  const lead = draft.lead;
  // No phone on file means nothing to call — the email stands on its own.
  if (lead.phoneE164 === null) return;

  const existing = await prisma.auditLog.findFirst({
    where: { action: 'reactivation.call-flagged', entityId: draftId },
  });
  if (existing !== null) return;

  const dueAt = new Date(draft.sentAt.getTime() + FIRST_TOUCH_DELAY_DAYS * MS_PER_DAY);
  const taskId = await createHubspotTask({
    subject: taskSubject(lead.name),
    body: taskBody(lead.name),
    dueAt,
    companyId: lead.hubspotCompanyId,
    draftId,
    touchNumber: FIRST_TOUCH_NUMBER,
  });

  await audit('reactivation.call-flagged', draftId, {
    leadId: lead.id,
    sentAt: draft.sentAt.toISOString(),
    taskId,
    dueAt: dueAt.toISOString(),
  });
};

export type ReactivationCallRow = {
  draftId: string;
  facility: string;
  city: string;
  state: string;
  phone: string;
  phoneE164: string;
  ownerName: string | null;
  hint: string;
  sentAt: Date;
};

export const buildReactivationCallRows = async (opts?: {
  limit?: number;
}): Promise<ReactivationCallRow[]> => {
  const limit = opts?.limit ?? 100;
  const cutoff = new Date(Date.now() - REACTIVATION_CALL_WINDOW_DAYS * MS_PER_DAY);
  const drafts = await prisma.draft.findMany({
    where: {
      kind: 'reactivation',
      status: { in: ['sent', 'auto-sent'] },
      sentAt: { gte: cutoff },
    },
    orderBy: { sentAt: 'desc' },
    take: limit * 3,
    include: { lead: { include: { enrichment: true } } },
  });
  const draftIds = drafts.map((d) => d.id);
  if (draftIds.length === 0) return [];

  const flaggedTaskByDraft = await loadFlaggedTaskByDraft(draftIds);
  const flaggedLeadIds = [
    ...new Set(
      drafts.filter((d) => flaggedTaskByDraft.has(d.id)).map((d) => d.lead.id),
    ),
  ];
  const repliedByLead = await loadRepliedAtByLead(flaggedLeadIds);

  // First pass: flagged, has a phone, deduped by lead, and the lead has not
  // replied since the send. Defer the HubSpot task-status lookup to this
  // narrowed set so we don't fetch tasks for rows we'd drop anyway.
  type Candidate = { draft: (typeof drafts)[number]; taskId: string | null };
  const candidates: Candidate[] = [];
  const seenLeadIds = new Set<string>();
  for (const d of drafts) {
    if (!flaggedTaskByDraft.has(d.id) || d.sentAt === null) continue;
    const lead = d.lead;
    if (lead.phoneE164 === null) continue;
    if (seenLeadIds.has(lead.id)) continue;
    const sentMs = d.sentAt.getTime();
    const replied = (repliedByLead.get(lead.id) ?? []).some((t) => t.getTime() >= sentMs);
    if (replied) continue;
    seenLeadIds.add(lead.id);
    candidates.push({ draft: d, taskId: flaggedTaskByDraft.get(d.id) ?? null });
  }

  const completedTaskIds = await loadCompletedTaskIds(
    candidates.map((c) => c.taskId).filter((id): id is string => id !== null),
  );

  const rows: ReactivationCallRow[] = [];
  for (const c of candidates) {
    if (c.taskId !== null && completedTaskIds.has(c.taskId)) continue;
    const d = c.draft;
    const lead = d.lead;
    if (d.sentAt === null || lead.phoneE164 === null) continue;

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
    });
    if (rows.length >= limit) break;
  }
  return rows;
};

export const countOpenReactivationCalls = async (): Promise<number> => {
  const rows = await buildReactivationCallRows({ limit: 500 });
  return rows.length;
};
