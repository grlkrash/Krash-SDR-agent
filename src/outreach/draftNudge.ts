// Nudge drafter. Pulls the most recent sent/paused draft for a lead, hands
// its body to Claude as "tone reference," and produces a short follow-up.
// No evaluator pass: nudges are ~90–120 words and approval-gated through
// /queue, so the score loop's marginal benefit doesn't justify the second
// Claude call.

import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';
import { claude, extractJSON } from '../shared/claude.js';
import { NUDGE_SYSTEM, buildNudgeUser } from '../prompts/nudge.js';
import { scanLeaks } from './leakScan.js';

const cached = (text: string): Array<TextBlockParam> => [
  { type: 'text', text, cache_control: { type: 'ephemeral' } },
];

const MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 1024;
const TEMPERATURE = 0.6;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const GenSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

const audit = (action: string, leadId: string, meta: Prisma.InputJsonValue): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'lead', entityId: leadId, meta } });

export const draftNudge = async (leadId: string): Promise<string | null> => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) return null;
  const { enrichment, ...leadOnly } = lead;
  if (enrichment === null) return null;

  if (lead.doNotContact) {
    await audit('draftNudge.do-not-contact', leadId, {});
    return null;
  }

  // The prior draft anchors tone for the nudge. status IN ('sent','paused')
  // covers both surfaces: the awaiting-reply path hands us a sent cold draft
  // that went quiet, and the paused-undo path hands us the draft Sonia hit
  // pause on. Most-recent wins because that's the freshest tone signal.
  const priorDraft = await prisma.draft.findFirst({
    where: { leadId, status: { in: ['sent', 'paused'] } },
    orderBy: { createdAt: 'desc' },
    select: { body: true },
  });
  if (priorDraft === null) {
    await audit('draftNudge.no-prior-draft', leadId, {});
    return null;
  }

  const msg = await claude.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: TEMPERATURE,
    system: cached(NUDGE_SYSTEM),
    messages: [{
      role: 'user',
      content: buildNudgeUser(leadOnly, enrichment, priorDraft.body),
    }],
  });
  const gen = GenSchema.parse(extractJSON(msg));

  // Hard pricing/tier-name gate — same gate cold drafts run through. A leak
  // here is a model-obedience failure worth surfacing in AuditLog; we skip
  // rather than retry so Sonia can investigate underlying enrichment data.
  const hits = scanLeaks(gen.body, [leadOnly.name]);
  if (hits.length > 0) {
    await audit('draftNudge.leak-detected', leadId, { hits });
    return null;
  }

  const draft = await prisma.draft.create({
    data: {
      leadId,
      kind: 'nudge',
      subject: gen.subject,
      body: gen.body,
      specificFacts: [],
      personalizationPct: null,
      status: 'pending',
    },
  });
  return draft.id;
};
