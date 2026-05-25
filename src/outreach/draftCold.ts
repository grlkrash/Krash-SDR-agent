import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';
import { claude, extractJSON } from '../shared/claude.js';
import {
  COLD_EMAIL_EVALUATOR_SYSTEM,
  COLD_EMAIL_SYSTEM,
  buildColdEmailUser,
} from '../prompts/coldEmail.js';
import { guessEmail } from '../shared/guessEmail.js';

const cached = (text: string): Array<TextBlockParam> => [
  { type: 'text', text, cache_control: { type: 'ephemeral' } },
];

const MODEL = 'claude-sonnet-4-5-20250929';
const GEN_MAX_TOKENS = 1024;
const GEN_TEMPERATURE = 0.7;
const EVAL_MAX_TOKENS = 512;
const EVAL_TEMPERATURE = 0.3;
// Contract is 60% — first attempt below this triggers a retry.
const RETRY_TRIGGER_PCT = 60;
// Evaluator runs strict; 58 on this grader is comfortably ≥60% real personalization.
const ACCEPT_FLOOR_PCT = 58;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const GenSchema = z.object({
  subject: z.string(),
  body: z.string(),
  specific_facts_used: z.array(z.string()),
});
type GenOutput = z.infer<typeof GenSchema>;

const EvalSchema = z.object({
  personalization_pct: z.number(),
  generic_sentences: z.array(z.string()).default([]),
});
type EvalOutput = { pct: number; genericSentences: string[] };

type ChatMessage = { role: 'user' | 'assistant'; content: string };

const audit = (action: string, leadId: string, meta: Prisma.InputJsonValue): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'lead', entityId: leadId, meta } });

const generate = async (messages: ChatMessage[]): Promise<GenOutput> => {
  const msg = await claude.messages.create({
    model: MODEL,
    max_tokens: GEN_MAX_TOKENS,
    temperature: GEN_TEMPERATURE,
    system: cached(COLD_EMAIL_SYSTEM),
    messages,
  });
  return GenSchema.parse(extractJSON(msg));
};

const evaluate = async (body: string, prospectFacts: unknown): Promise<EvalOutput> => {
  const msg = await claude.messages.create({
    model: MODEL,
    max_tokens: EVAL_MAX_TOKENS,
    temperature: EVAL_TEMPERATURE,
    system: cached(COLD_EMAIL_EVALUATOR_SYSTEM),
    messages: [{
      role: 'user',
      content: `Email body:\n${body}\n\nProspect facts:\n${JSON.stringify(prospectFacts, null, 2)}`,
    }],
  });
  const parsed = EvalSchema.parse(extractJSON(msg));
  return { pct: parsed.personalization_pct, genericSentences: parsed.generic_sentences };
};

export const draftColdEmail = async (leadId: string): Promise<string | null> => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) return null;
  const { enrichment, ...leadOnly } = lead;
  if (enrichment === null) return null;

  const existing = await prisma.draft.findFirst({
    where: { leadId, kind: 'cold', status: { not: 'rejected' } },
    select: { id: true },
  });
  if (existing !== null) return null;

  const targetEmail = enrichment.ownerEmail ?? guessEmail(enrichment.ownerName, lead.website);
  if (targetEmail === null) {
    await audit('draftCold.no-email', leadId, {});
    return null;
  }

  const suppressed = await prisma.suppression.findFirst({ where: { email: targetEmail } });
  if (suppressed !== null) {
    await audit('draftCold.suppressed', leadId, { email: targetEmail });
    return null;
  }

  // Re-draft path: if every prior cold draft for this lead was rejected, the
  // operator's most recent reject reason becomes one extra paragraph appended
  // to the user message. The system prompt stays cached, so this is ~60
  // additional input tokens gated on `rejectReason !== null` — paused drafts
  // are excluded by `status: 'rejected'`.
  const previousRejected = await prisma.draft.findFirst({
    where: { leadId, kind: 'cold', status: 'rejected', rejectReason: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, rejectReason: true },
  });
  const previousRejectReason = previousRejected?.rejectReason ?? null;

  const prospectFacts = { lead: leadOnly, enrichment };
  const baseUser = buildColdEmailUser(leadOnly, enrichment, previousRejectReason);

  if (previousRejectReason !== null && previousRejected !== null) {
    await audit('draftCold.reject-feedback-used', leadId, {
      previousDraftId: previousRejected.id,
      reasonChars: previousRejectReason.length,
    });
  }

  let gen = await generate([{ role: 'user', content: baseUser }]);
  let evalResult = await evaluate(gen.body, prospectFacts);

  if (evalResult.pct < RETRY_TRIGGER_PCT) {
    const firstAttempt = gen;
    const firstPct = evalResult.pct;
    const firstGenericSentences = evalResult.genericSentences;
    const retryFeedback = `That draft scored only ${firstPct}% personalization. The evaluator flagged these as generic sentences: ${JSON.stringify(firstGenericSentences)}. Rewrite the email. Replace every generic sentence with one containing a specific fact about THIS prospect (exact review count, named service, owner name, named missing directory, detected tool, or hiring role). Output the same JSON schema.`;
    gen = await generate([
      { role: 'user', content: baseUser },
      { role: 'assistant', content: JSON.stringify(firstAttempt) },
      { role: 'user', content: retryFeedback },
    ]);
    evalResult = await evaluate(gen.body, prospectFacts);
    if (evalResult.pct < ACCEPT_FLOOR_PCT) {
      await audit('draftCold.score-too-low', leadId, {
        firstPct,
        retryPct: evalResult.pct,
        firstGenericSentences,
        retryGenericSentences: evalResult.genericSentences,
      });
      return null;
    }
  }

  try {
    const draft = await prisma.draft.create({
      data: {
        leadId,
        kind: 'cold',
        subject: gen.subject,
        body: gen.body,
        personalizationPct: evalResult.pct,
        specificFacts: gen.specific_facts_used,
        status: 'pending',
      },
    });
    return draft.id;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      await audit('draftCold.duplicate-race-avoided', leadId, {});
      return null;
    }
    throw error;
  }
};
