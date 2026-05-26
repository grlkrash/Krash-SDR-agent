// Upsell drafter. Triggered by draftUpsellBatch when a closed-won customer
// surfaces a NEW growth signal. Caller derives the one-line `signalSummary`
// from enrichment.signals so this helper stays signal-agnostic — same shape
// as draftNudge: one Claude call, no evaluator, leak-scan gate, approval-
// gated in /queue. The 60-day per-lead cooldown is enforced HERE (not in
// the batch script) so any other future caller is protected too.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';
import { claude, extractJSON } from '../shared/claude.js';
import { UPSELL_SYSTEM, buildUpsellUser } from '../prompts/upsell.js';
import { scanLeaks } from './leakScan.js';

const cached = (text: string): Array<TextBlockParam> => [
  { type: 'text', text, cache_control: { type: 'ephemeral' } },
];

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 512;
const TEMPERATURE = 0.6;

const MS_PER_DAY = 86_400_000;
const COOLDOWN_DAYS = 60;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const GenSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

const audit = (action: string, leadId: string, meta: Prisma.InputJsonValue): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'lead', entityId: leadId, meta } });

export const draftUpsell = async (
  leadId: string,
  signalSummary: string,
): Promise<string | null> => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) return null;
  const { enrichment, ...leadOnly } = lead;
  if (enrichment === null) return null;

  if (lead.doNotContact) {
    await audit('draftUpsell.do-not-contact', leadId, {});
    return null;
  }

  // 60d per-lead cooldown — covers any prior upsell draft regardless of
  // status (pending/approved/sent/rejected/paused). A rejected upsell still
  // burns the slot so Sonia isn't seeing the same growth-signal pitch
  // re-drafted every day until the signal naturally falls off enrichment.
  const cooldownCutoff = new Date(Date.now() - COOLDOWN_DAYS * MS_PER_DAY);
  const recent = await prisma.draft.findFirst({
    where: { leadId, kind: 'upsell', createdAt: { gt: cooldownCutoff } },
    select: { id: true },
  });
  if (recent !== null) {
    await audit('draftUpsell.recent-exists', leadId, { existingDraftId: recent.id });
    return null;
  }

  const msg = await claude.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: cached(UPSELL_SYSTEM),
    messages: [{
      role: 'user',
      content: buildUpsellUser(leadOnly, enrichment, signalSummary),
    }],
  });
  const gen = GenSchema.parse(extractJSON(msg));

  // Same pricing/tier-name gate cold and nudge drafts run through. A leak
  // here indicates UPSELL_SYSTEM rules were violated; skip rather than retry
  // so the failure surfaces in AuditLog for inspection.
  const hits = scanLeaks(gen.body, [leadOnly.name]);
  if (hits.length > 0) {
    await audit('draftUpsell.leak-detected', leadId, { hits });
    return null;
  }

  const draft = await prisma.draft.create({
    data: {
      leadId,
      kind: 'upsell',
      subject: gen.subject,
      body: gen.body,
      specificFacts: [signalSummary],
      personalizationPct: null,
      status: 'pending',
    },
  });
  return draft.id;
};
