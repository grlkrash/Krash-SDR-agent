// Surfaces booked meetings whose scheduled time has already passed so Sonia can
// send a recap (if it was held) or a reschedule (if it was a no-show). Voicemail
// is paused and we can't reliably read meeting outcomes, so rather than guess
// no-show vs held we put the recently-passed meeting in front of the operator
// to decide.
//
// Source of truth is the meeting.booked AuditLog written by meetingAttribution
// (it captures startAt). A lead drops off once they reply after the meeting
// time — that reply means the relationship moved on its own.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { callHint, formatPhoneForDisplay } from './brief/shared.js';

const MS_PER_DAY = 86_400_000;
const FOLLOWUP_WINDOW_DAYS = 7;
const REPLIED_KIND = 'replied';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const BookedMetaSchema = z.object({
  leadId: z.string(),
  startAt: z.string().nullable().optional(),
});

export type MeetingFollowupRow = {
  leadId: string;
  facility: string;
  city: string;
  state: string;
  phone: string | null;
  ownerName: string | null;
  hint: string;
  startAt: Date;
};

// Latest passed meeting per lead within the window.
const loadPassedMeetingsByLead = async (
  windowStartMs: number,
  nowMs: number,
): Promise<Map<string, Date>> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'meeting.booked' },
    select: { meta: true },
  });
  const byLead = new Map<string, Date>();
  for (const row of rows) {
    const parsed = BookedMetaSchema.safeParse(row.meta);
    if (!parsed.success) continue;
    const { leadId, startAt } = parsed.data;
    if (startAt === null || startAt === undefined) continue;
    const startMs = Date.parse(startAt);
    if (Number.isNaN(startMs)) continue;
    if (startMs < windowStartMs || startMs > nowMs) continue;
    const existing = byLead.get(leadId);
    if (existing === undefined || startMs > existing.getTime()) {
      byLead.set(leadId, new Date(startMs));
    }
  }
  return byLead;
};

// Leads that replied at or after their meeting time — they re-engaged, so no
// reschedule nudge is needed.
const loadRepliedAfter = async (
  startByLead: Map<string, Date>,
): Promise<Set<string>> => {
  const leadIds = [...startByLead.keys()];
  if (leadIds.length === 0) return new Set();
  const rows = await prisma.draft.findMany({
    where: { leadId: { in: leadIds }, kind: REPLIED_KIND },
    select: { leadId: true, createdAt: true },
  });
  const replied = new Set<string>();
  for (const r of rows) {
    const start = startByLead.get(r.leadId);
    if (start !== undefined && r.createdAt.getTime() >= start.getTime()) {
      replied.add(r.leadId);
    }
  }
  return replied;
};

export const buildMeetingFollowupRows = async (opts?: {
  limit?: number;
}): Promise<MeetingFollowupRow[]> => {
  const limit = opts?.limit ?? 100;
  const nowMs = Date.now();
  const windowStartMs = nowMs - FOLLOWUP_WINDOW_DAYS * MS_PER_DAY;

  const startByLead = await loadPassedMeetingsByLead(windowStartMs, nowMs);
  if (startByLead.size === 0) return [];

  const repliedAfter = await loadRepliedAfter(startByLead);
  const candidateLeadIds = [...startByLead.keys()].filter((id) => !repliedAfter.has(id));
  if (candidateLeadIds.length === 0) return [];

  const leads = await prisma.lead.findMany({
    where: { id: { in: candidateLeadIds } },
    include: { enrichment: true },
  });

  const rows: MeetingFollowupRow[] = [];
  for (const lead of leads) {
    const startAt = startByLead.get(lead.id);
    if (startAt === undefined) continue;
    rows.push({
      leadId: lead.id,
      facility: lead.name,
      city: lead.city,
      state: lead.state,
      phone: lead.phoneE164 === null ? null : formatPhoneForDisplay(lead.phoneE164),
      ownerName: lead.enrichment?.ownerName ?? null,
      hint: callHint(lead.state),
      startAt,
    });
  }
  rows.sort((a, b) => b.startAt.getTime() - a.startAt.getTime());
  return rows.slice(0, limit);
};

export const countOpenMeetingFollowups = async (): Promise<number> => {
  const rows = await buildMeetingFollowupRows({ limit: 500 });
  return rows.length;
};
