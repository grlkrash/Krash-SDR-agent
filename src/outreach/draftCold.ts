import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { claude, extractJSON } from '../shared/claude.js';
import {
  COLD_EMAIL_EVALUATOR_SYSTEM,
  COLD_EMAIL_SYSTEM,
  buildColdEmailUser,
} from '../prompts/coldEmail.js';
import { guessEmail } from '../shared/guessEmail.js';

const MODEL = 'claude-sonnet-4-5-20250929';
const GEN_MAX_TOKENS = 1024;
const GEN_TEMPERATURE = 0.7;
const EVAL_MAX_TOKENS = 512;
const EVAL_TEMPERATURE = 0.3;
const MIN_PERSONALIZATION_PCT = 60;

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
});

const audit = (action: string, leadId: string, meta: Prisma.InputJsonValue): Promise<unknown> =>
  prisma.auditLog.create({ data: { action, entity: 'lead', entityId: leadId, meta } });

const generate = async (userContent: string): Promise<GenOutput> => {
  const msg = await claude.messages.create({
    model: MODEL,
    max_tokens: GEN_MAX_TOKENS,
    temperature: GEN_TEMPERATURE,
    system: COLD_EMAIL_SYSTEM,
    messages: [{ role: 'user', content: userContent }],
  });
  return GenSchema.parse(extractJSON(msg));
};

const evaluate = async (body: string, prospectFacts: unknown): Promise<number> => {
  const msg = await claude.messages.create({
    model: MODEL,
    max_tokens: EVAL_MAX_TOKENS,
    temperature: EVAL_TEMPERATURE,
    system: COLD_EMAIL_EVALUATOR_SYSTEM,
    messages: [{
      role: 'user',
      content: `Email body:\n${body}\n\nProspect facts:\n${JSON.stringify(prospectFacts, null, 2)}`,
    }],
  });
  return EvalSchema.parse(extractJSON(msg)).personalization_pct;
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

  const prospectFacts = { lead: leadOnly, enrichment };
  const baseUser = buildColdEmailUser(leadOnly, enrichment);

  let gen = await generate(baseUser);
  let pct = await evaluate(gen.body, prospectFacts);

  if (pct < MIN_PERSONALIZATION_PCT) {
    const retryUser = `${baseUser}\n\nPrevious attempt scored ${pct}%. Increase prospect-specific references to ≥60%. Reference at least one intelligence signal if present (hiring, missing directories, tech stack).`;
    gen = await generate(retryUser);
    pct = await evaluate(gen.body, prospectFacts);
    if (pct < MIN_PERSONALIZATION_PCT) {
      await audit('draftCold.score-too-low', leadId, { pct });
      return null;
    }
  }

  const draft = await prisma.draft.create({
    data: {
      leadId,
      kind: 'cold',
      subject: gen.subject,
      body: gen.body,
      personalizationPct: pct,
      specificFacts: gen.specific_facts_used,
      status: 'pending',
    },
  });

  return draft.id;
};
