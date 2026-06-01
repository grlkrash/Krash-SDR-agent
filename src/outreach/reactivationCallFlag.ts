// Flags sent reactivation emails for a manual call. Voicemail is paused, so a
// reactivation that used to trigger an AI voicemail now creates one HubSpot
// call task and surfaces in the daily brief "Reactivations to call" section.
//
// Deliberately leaner than the renewal call lane: a single touch, no multi-day
// cadence and no web UI. Items age out of the 14-day window automatically;
// the HubSpot task is the system of record for working the call.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { createHubspotTask } from '../shared/hubspotTask.js';
import { callHint, formatPhoneForDisplay } from './brief/shared.js';

const MS_PER_DAY = 86_400_000;
const REACTIVATION_CALL_WINDOW_DAYS = 14;
const FIRST_TOUCH_DELAY_DAYS = 1;
const FIRST_TOUCH_NUMBER = 1;

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

const loadFlaggedDraftIds = async (draftIds: string[]): Promise<Set<string>> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'reactivation.call-flagged', entityId: { in: draftIds } },
    select: { entityId: true },
  });
  return new Set(rows.map((r) => r.entityId).filter((id): id is string => id !== null));
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

  const flagged = await loadFlaggedDraftIds(draftIds);

  const rows: ReactivationCallRow[] = [];
  const seenLeadIds = new Set<string>();
  for (const d of drafts) {
    if (!flagged.has(d.id) || d.sentAt === null) continue;
    const lead = d.lead;
    if (lead.phoneE164 === null) continue;
    if (seenLeadIds.has(lead.id)) continue;
    seenLeadIds.add(lead.id);

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
