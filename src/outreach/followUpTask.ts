// Operator-scheduled follow-up calls — AuditLog + HubSpot task mirror (no new table).

import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { hs, hsRetry } from '../shared/hubspot.js';
import { createHubspotTask, completeHubspotTask } from '../shared/hubspotTask.js';
import { parseFollowUpDateLocal } from '../shared/parseFollowUpDate.js';
import { formatPhoneForDisplay, callHint } from './brief/shared.js';

const HUBSPOT_TASK_COMPLETED = 'COMPLETED';
const FOLLOW_UP_TOUCH = 0;
const LOOKBACK_DAYS = 120;
const MS_PER_DAY = 86_400_000;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const audit = (
  action: string,
  entityId: string,
  meta: Prisma.InputJsonValue,
): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'lead', entityId, meta } });

type ScheduledMeta = {
  followUpId?: string;
  taskId?: string | null;
  dueAt?: string;
  context?: string;
  notes?: string;
  facility?: string;
};

const parseScheduledMeta = (meta: unknown): ScheduledMeta => {
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return {};
  return meta as ScheduledMeta;
};

const loadCompletedFollowUpIds = async (): Promise<Set<string>> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'followup-task.completed' },
    select: { meta: true },
  });
  const ids = new Set<string>();
  for (const row of rows) {
    const id = parseScheduledMeta(row.meta).followUpId;
    if (typeof id === 'string' && id !== '') ids.add(id);
  }
  return ids;
};

const hubspotTaskClosed = async (taskId: string): Promise<boolean> => {
  try {
    const task = await hsRetry(() =>
      hs.crm.objects.tasks.basicApi.getById(taskId, ['hs_task_status']),
    );
    return task.properties?.hs_task_status === HUBSPOT_TASK_COMPLETED;
  } catch {
    return false;
  }
};

export const scheduleFollowUpTask = async (opts: {
  leadId: string;
  dueAtLocal: string;
  context: string;
  notes?: string;
}): Promise<{ followUpId: string; taskId: string | null }> => {
  const dueAt = parseFollowUpDateLocal(opts.dueAtLocal);
  if (dueAt.getTime() <= Date.now()) {
    throw new Error('Follow-up time must be in the future');
  }
  const lead = await prisma.lead.findUnique({
    where: { id: opts.leadId },
    include: { enrichment: true },
  });
  if (lead === null) throw new Error('Lead not found');

  const notes = opts.notes?.trim() ?? '';
  const followUpId = randomUUID();
  const subject = `Follow up — ${lead.name}`;
  const bodyParts = [
    `Operator follow-up for ${lead.name} (${lead.city}, ${lead.state}).`,
    `Context: ${opts.context}.`,
    notes !== '' ? `Notes: ${notes}` : '',
    'Scheduled from SSA — see /follow-ups queue.',
  ].filter((p) => p !== '');
  const taskId = await createHubspotTask({
    subject,
    body: bodyParts.join('\n'),
    dueAt,
    companyId: lead.hubspotCompanyId,
    draftId: opts.leadId,
    touchNumber: FOLLOW_UP_TOUCH,
    taskType: 'CALL',
  });

  await audit('followup-task.scheduled', opts.leadId, {
    followUpId,
    taskId,
    dueAt: dueAt.toISOString(),
    context: opts.context,
    notes: notes !== '' ? notes : undefined,
    facility: lead.name,
  });

  return { followUpId, taskId };
};

export type FollowUpRow = {
  followUpId: string;
  leadId: string;
  facility: string;
  city: string;
  state: string;
  phone: string;
  phoneE164: string;
  ownerName: string | null;
  hint: string;
  dueAt: Date;
  context: string;
  notes: string | null;
  taskId: string | null;
  hubspotCompanyId: string | null;
};

export const buildFollowUpRows = async (opts?: { limit?: number }): Promise<FollowUpRow[]> => {
  const limit = opts?.limit ?? 100;
  const cutoff = new Date(Date.now() - LOOKBACK_DAYS * MS_PER_DAY);
  const [scheduled, completedIds] = await Promise.all([
    prisma.auditLog.findMany({
      where: { action: 'followup-task.scheduled', createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'desc' },
      take: limit * 3,
      select: { entityId: true, meta: true, createdAt: true },
    }),
    loadCompletedFollowUpIds(),
  ]);

  const open: Array<{ followUpId: string; leadId: string; meta: ScheduledMeta }> = [];
  for (const row of scheduled) {
    if (row.entityId === null) continue;
    const meta = parseScheduledMeta(row.meta);
    const followUpId = meta.followUpId;
    if (typeof followUpId !== 'string' || followUpId === '') continue;
    if (completedIds.has(followUpId)) continue;
    open.push({ followUpId, leadId: row.entityId, meta });
  }

  const rows: FollowUpRow[] = [];
  const seen = new Set<string>();

  for (const item of open) {
    if (seen.has(item.followUpId)) continue;
    const taskId = typeof item.meta.taskId === 'string' ? item.meta.taskId : null;
    if (taskId !== null && await hubspotTaskClosed(taskId)) {
      await audit('followup-task.completed', item.leadId, {
        followUpId: item.followUpId,
        taskId,
        source: 'hubspot-sync',
      });
      completedIds.add(item.followUpId);
      continue;
    }

    const dueRaw = item.meta.dueAt;
    const dueMs = typeof dueRaw === 'string' ? Date.parse(dueRaw) : Number.NaN;
    if (Number.isNaN(dueMs)) continue;

    const lead = await prisma.lead.findUnique({
      where: { id: item.leadId },
      include: { enrichment: true },
    });
    if (lead === null || lead.phoneE164 === null) continue;

    seen.add(item.followUpId);
    rows.push({
      followUpId: item.followUpId,
      leadId: item.leadId,
      facility: lead.name,
      city: lead.city,
      state: lead.state,
      phone: formatPhoneForDisplay(lead.phoneE164),
      phoneE164: lead.phoneE164,
      ownerName: lead.enrichment?.ownerName ?? null,
      hint: callHint(lead.state),
      dueAt: new Date(dueMs),
      context: typeof item.meta.context === 'string' ? item.meta.context : 'follow-up',
      notes: typeof item.meta.notes === 'string' && item.meta.notes !== '' ? item.meta.notes : null,
      taskId,
      hubspotCompanyId: lead.hubspotCompanyId,
    });
    if (rows.length >= limit) break;
  }

  rows.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  return rows;
};

export const countOpenFollowUps = async (): Promise<number> => {
  const rows = await buildFollowUpRows({ limit: 500 });
  return rows.length;
};

export const completeFollowUpTask = async (followUpId: string): Promise<void> => {
  const scheduled = await prisma.auditLog.findFirst({
    where: {
      action: 'followup-task.scheduled',
      meta: { path: ['followUpId'], equals: followUpId },
    },
    orderBy: { createdAt: 'desc' },
    select: { entityId: true, meta: true },
  });
  if (scheduled === null || scheduled.entityId === null) {
    throw new Error('Follow-up task not found');
  }

  const existing = await prisma.auditLog.findFirst({
    where: {
      action: 'followup-task.completed',
      meta: { path: ['followUpId'], equals: followUpId },
    },
  });
  if (existing !== null) return;

  const meta = parseScheduledMeta(scheduled.meta);
  const taskId = typeof meta.taskId === 'string' && meta.taskId !== '' ? meta.taskId : null;
  if (taskId !== null) {
    await completeHubspotTask({ taskId, draftId: scheduled.entityId });
  }

  await audit('followup-task.completed', scheduled.entityId, {
    followUpId,
    taskId,
    source: 'operator-queue',
  });
};
