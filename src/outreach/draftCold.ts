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
import {
  assessColdDraftQuality,
  buildDraftQualityRetryFeedback,
  hasFreeListingEntryHook,
  type SubjectProspectContext,
} from './coldEmailQuality.js';
import { isExcludedFromCold } from '../shared/exclusion.js';
import { guessEmail } from '../shared/guessEmail.js';
import { scanLeaks } from './leakScan.js';

const cached = (text: string): Array<TextBlockParam> => [
  { type: 'text', text, cache_control: { type: 'ephemeral' } },
];

const MODEL = 'claude-sonnet-4-5-20250929';
const GEN_MAX_TOKENS = 1536;
const GEN_TEMPERATURE = 0.7;
const EVAL_MAX_TOKENS = 768;
const EVAL_TEMPERATURE = 0.3;
const RETRY_TRIGGER_PCT = 60;
const ACCEPT_FLOOR_PCT = 58;
const MAX_REJECTS_PER_LEAD = 3;

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
  has_market_pain_context: z.boolean().default(false),
  has_ss_product_context: z.boolean().default(false),
  word_count: z.number().optional(),
});
type EvalOutput = {
  pct: number;
  genericSentences: string[];
  hasMarketPain: boolean;
  hasSsProduct: boolean;
};

type ChatMessage = { role: 'user' | 'assistant'; content: string };

type AttemptSnapshot = {
  gen: GenOutput;
  quality: ReturnType<typeof assessColdDraftQuality>;
  evalResult: EvalOutput;
};

const subjectContext = (
  lead: { name: string; city: string; state: string; services: string[] },
  enrichment: { ownerName: string | null },
): SubjectProspectContext => ({
  facilityName: lead.name,
  city: lead.city,
  state: lead.state,
  ownerName: enrichment.ownerName,
  services: lead.services,
});

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
  return {
    pct: parsed.personalization_pct,
    genericSentences: parsed.generic_sentences,
    hasMarketPain: parsed.has_market_pain_context,
    hasSsProduct: parsed.has_ss_product_context,
  };
};

const needsRetry = (
  quality: ReturnType<typeof assessColdDraftQuality>,
  evalResult: EvalOutput,
  body: string,
): boolean =>
  !quality.ok
  || evalResult.pct < RETRY_TRIGGER_PCT
  || !evalResult.hasSsProduct
  || !evalResult.hasMarketPain
  || !hasFreeListingEntryHook(body);

const buildRetryFeedback = (
  quality: ReturnType<typeof assessColdDraftQuality>,
  evalResult: EvalOutput,
  body: string,
): string => {
  const parts: string[] = [];

  if (evalResult.pct < RETRY_TRIGGER_PCT) {
    parts.push(
      `That draft scored only ${evalResult.pct}% personalization. The evaluator flagged these as generic sentences: ${JSON.stringify(evalResult.genericSentences)}. Replace every generic sentence with one containing a specific fact about THIS prospect (exact review count, named service, owner name, named missing directory, detected tool, or hiring role).`,
    );
  }
  if (!evalResult.hasMarketPain) {
    parts.push(
      'Missing MARKET PAIN paragraph: add 2–3 sentences on industry pressure (paid-search YoY 124%/62% for select/premium, or restricted ad channels for smaller operators) and bridge to this prospect\'s city/market.',
    );
  }
  if (!evalResult.hasSsProduct) {
    parts.push(
      'Missing SS IDENTITY paragraph: explain who Sobriety Select is (map-forward directory, region + insurance discovery, rich profiles, complements existing marketing) in 2–3 sentences before the CTA.',
    );
  }
  if (!hasFreeListingEntryHook(body)) {
    parts.push(
      'Include the FREE-LISTING ENTRY OFFER: Sobriety Select has pre-built a basic profile from public information — offer to get it claimed, verified, and live (no card, no obligation). Use "free" in the body (never in the subject). Paid tiers are for the call only.',
    );
  }
  if (!quality.ok) {
    parts.push(buildDraftQualityRetryFeedback(quality, body));
  }

  parts.push('Output the same JSON schema. Target 130–165 words; subject ≤6 words with a prospect token.');
  return parts.join(' ');
};

export const draftColdEmail = async (leadId: string): Promise<string | null> => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) return null;
  const { enrichment, ...leadOnly } = lead;
  if (enrichment === null) return null;

  if (lead.doNotContact) {
    await audit('draftCold.do-not-contact', leadId, {});
    return null;
  }

  if (isExcludedFromCold(lead)) {
    await audit('draftCold.excluded', leadId, {});
    return null;
  }

  const existing = await prisma.draft.findFirst({
    where: { leadId, kind: 'cold', status: { not: 'rejected' } },
    select: { id: true },
  });
  if (existing !== null) return null;

  const rejectedCount = await prisma.draft.count({
    where: { leadId, kind: 'cold', status: 'rejected' },
  });
  const batchRedraft = process.env.DRAFT_COLD_BATCH_REDRAFT === '1';
  if (rejectedCount >= MAX_REJECTS_PER_LEAD && !batchRedraft) {
    await audit('draftCold.skipped-too-many-rejects', leadId, {
      rejectedCount,
      capacity: MAX_REJECTS_PER_LEAD,
    });
    return null;
  }

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

  const subjCtx = subjectContext(leadOnly, enrichment);

  let gen = await generate([{ role: 'user', content: baseUser }]);

  const firstLeaks = scanLeaks(gen.body, [leadOnly.name]);
  if (firstLeaks.length > 0) {
    await audit('draftCold.leak-detected', leadId, { attempt: 'first', hits: firstLeaks });
    return null;
  }

  let quality = assessColdDraftQuality(gen.subject, gen.body, subjCtx);
  let evalResult = await evaluate(gen.body, prospectFacts);

  if (needsRetry(quality, evalResult, gen.body)) {
    const firstAttempt = gen;
    const firstSnapshot: AttemptSnapshot = { gen, quality, evalResult };

    await audit('draftCold.retry-triggered', leadId, {
      firstPct: evalResult.pct,
      wordCount: quality.body.wordCount,
      subjectIssues: quality.subject.issues,
      qualityIssues: quality.body.issues,
      hasMarketPain: evalResult.hasMarketPain,
      hasSsProduct: evalResult.hasSsProduct,
    });

    gen = await generate([
      { role: 'user', content: baseUser },
      { role: 'assistant', content: JSON.stringify(firstAttempt) },
      { role: 'user', content: buildRetryFeedback(quality, evalResult, gen.body) },
    ]);

    const retryLeaks = scanLeaks(gen.body, [leadOnly.name]);
    if (retryLeaks.length > 0) {
      await audit('draftCold.leak-detected', leadId, { attempt: 'retry', hits: retryLeaks });
      return null;
    }

    quality = assessColdDraftQuality(gen.subject, gen.body, subjCtx);
    evalResult = await evaluate(gen.body, prospectFacts);

    const retryFailed =
      evalResult.pct < ACCEPT_FLOOR_PCT
      || !quality.ok
      || !evalResult.hasSsProduct
      || !evalResult.hasMarketPain
      || !hasFreeListingEntryHook(gen.body);

    if (retryFailed) {
      await audit('draftCold.quality-rejected', leadId, {
        firstPct: firstSnapshot.evalResult.pct,
        retryPct: evalResult.pct,
        firstWordCount: firstSnapshot.quality.body.wordCount,
        retryWordCount: quality.body.wordCount,
        firstSubjectIssues: firstSnapshot.quality.subject.issues,
        retrySubjectIssues: quality.subject.issues,
        firstQualityIssues: firstSnapshot.quality.body.issues,
        retryQualityIssues: quality.body.issues,
        retryHasMarketPain: evalResult.hasMarketPain,
        retryHasSsProduct: evalResult.hasSsProduct,
        firstGenericSentences: firstSnapshot.evalResult.genericSentences,
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
