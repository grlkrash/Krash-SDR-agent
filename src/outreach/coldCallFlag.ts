// Interleaves a human call touch into the cold email sequence. Their best-
// performing sequences pair email with phone, so when a cold email is sent to a
// prospect with a phone on file we create one HubSpot call task and surface it
// in the daily brief "Cold calls to make" section.
//
// Mirrors the reactivation call lane: a single touch, no web UI, the HubSpot
// task is the system of record. A cold call drops off the brief once the task is
// COMPLETED, the lead replies, or the lead books a meeting (no point cold-
// calling someone already on the calendar).

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { hs, hsRetry } from '../shared/hubspot.js';
import { createHubspotTask } from '../shared/hubspotTask.js';
import { businessDay } from '../shared/businessDays.js';
import { callHint, formatPhoneForDisplay } from './brief/shared.js';

const MS_PER_DAY = 86_400_000;
const COLD_CALL_WINDOW_DAYS = 10;
const FIRST_TOUCH_DELAY_BUSINESS_DAYS = 2;
const FIRST_TOUCH_NUMBER = 1;
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

const taskSubject = (facility: string): string => `Cold call — ${facility}`;

const taskBody = (facility: string, city: string): string =>
  `Cold email sent to ${facility} (${city}). Pair it with a live call to introduce `
  + 'the free Sobriety Select profile and offer a quick walkthrough. Lead with the '
  + 'free listing; keep any paid tier for the booked call.';

type FlagMeta = { taskId?: string | null };

const parseTaskId = (meta: unknown): string | null => {
  if (meta === null || typeof meta !== 'object') return null;
  const id = (meta as FlagMeta).taskId;
  return typeof id === 'string' && id !== '' ? id : null;
};

const loadFlaggedTaskByDraft = async (
  draftIds: string[],
): Promise<Map<string, string | null>> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'cold.call-flagged', entityId: { in: draftIds } },
    select: { entityId: true, meta: true },
  });
  const map = new Map<string, string | null>();
  for (const r of rows) {
    if (r.entityId === null || map.has(r.entityId)) continue;
    map.set(r.entityId, parseTaskId(r.meta));
  }
  return map;
};

// Inbound replies per lead. A reply after the cold send means they engaged —
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
// No reason to cold-call someone already on the calendar.
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

  const dueAt = businessDay(draft.sentAt, FIRST_TOUCH_DELAY_BUSINESS_DAYS);
  const taskId = await createHubspotTask({
    subject: taskSubject(lead.name),
    body: taskBody(lead.name, lead.city),
    dueAt,
    companyId: lead.hubspotCompanyId,
    draftId,
    touchNumber: FIRST_TOUCH_NUMBER,
  });

  await audit('cold.call-flagged', draftId, {
    leadId: lead.id,
    sentAt: draft.sentAt.toISOString(),
    taskId,
    dueAt: dueAt.toISOString(),
  });
};

export type ColdCallRow = {
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

export const buildColdCallRows = async (opts?: {
  limit?: number;
}): Promise<ColdCallRow[]> => {
  const limit = opts?.limit ?? 100;
  const cutoff = new Date(Date.now() - COLD_CALL_WINDOW_DAYS * MS_PER_DAY);
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

  const flaggedTaskByDraft = await loadFlaggedTaskByDraft(draftIds);
  const flaggedLeadIds = [
    ...new Set(
      drafts.filter((d) => flaggedTaskByDraft.has(d.id)).map((d) => d.lead.id),
    ),
  ];
  const [repliedByLead, bookedLeadIds] = await Promise.all([
    loadRepliedAtByLead(flaggedLeadIds),
    loadBookedLeadIds(flaggedLeadIds),
  ]);

  type Candidate = { draft: (typeof drafts)[number]; taskId: string | null };
  const candidates: Candidate[] = [];
  const seenLeadIds = new Set<string>();
  for (const d of drafts) {
    if (!flaggedTaskByDraft.has(d.id) || d.sentAt === null) continue;
    const lead = d.lead;
    if (lead.phoneE164 === null) continue;
    if (seenLeadIds.has(lead.id)) continue;
    if (bookedLeadIds.has(lead.id)) continue;
    const sentMs = d.sentAt.getTime();
    const replied = (repliedByLead.get(lead.id) ?? []).some((t) => t.getTime() >= sentMs);
    if (replied) continue;
    seenLeadIds.add(lead.id);
    candidates.push({ draft: d, taskId: flaggedTaskByDraft.get(d.id) ?? null });
  }

  const completedTaskIds = await loadCompletedTaskIds(
    candidates.map((c) => c.taskId).filter((id): id is string => id !== null),
  );

  const rows: ColdCallRow[] = [];
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

export const countOpenColdCalls = async (): Promise<number> => {
  const rows = await buildColdCallRows({ limit: 500 });
  return rows.length;
};
