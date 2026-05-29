import { describe, it, expect, afterEach } from 'vitest';
import type { Enrichment, Lead } from '@prisma/client';
import { z } from 'zod';
import type { Message } from '@anthropic-ai/sdk/resources/messages';
import { claude, extractJSON, setClaudeMock } from '../../src/shared/claude.js';
import {
  buildColdEmailUser,
  COLD_EMAIL_EVALUATOR_SYSTEM,
  COLD_EMAIL_SYSTEM,
} from '../../src/prompts/coldEmail.js';

const MODEL = 'claude-sonnet-4-5-20250929';
const GEN_MAX_TOKENS = 1536;
const GEN_TEMPERATURE = 0.7;
const EVAL_MAX_TOKENS = 512;
const EVAL_TEMPERATURE = 0.3;

const GenSchema = z.object({
  subject: z.string(),
  body: z.string(),
  specific_facts_used: z.array(z.string()),
});

const EvalSchema = z.object({
  personalization_pct: z.number(),
  generic_sentences: z.array(z.string()).default([]),
});

const EMPTY_SIGNALS = {
  competingDirectories: { onAnyDirectory: false, missingFromAll: false },
  hiring: { active: false, roleTitles: [] as string[], rolesPostedRecently: 0 },
  techStack: {
    hubspot: false,
    salesforce: false,
    callrail: false,
    googleAds: false,
    facebookPixel: false,
    marketo: false,
    bigSpenderScore: 0,
  },
};

const mockClaudeMessage = (payload: unknown): Message => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
});

const isEvaluatorCall = (messages: Array<{ role: string; content: unknown }>): boolean => {
  const first = messages[0];
  if (first === undefined || first.role !== 'user') return false;
  return typeof first.content === 'string' && first.content.startsWith('Email body:');
};

const runColdEmailFlow = async (
  lead: Lead,
  enrichment: Enrichment,
  genPayload: z.infer<typeof GenSchema>,
  evalPct: number,
): Promise<{ subject: string; body: string; pct: number }> => {
  const userPrompt = buildColdEmailUser(lead, enrichment);
  let gen: z.infer<typeof GenSchema> | null = null;
  let pct = 0;

  setClaudeMock(async (args) => {
    if (isEvaluatorCall(args.messages)) {
      return mockClaudeMessage({
        personalization_pct: evalPct,
        generic_sentences: [],
        specific_sentences: [],
        reasoning: 'test',
      });
    }
    return mockClaudeMessage(genPayload);
  });

  const genMsg = await claude.messages.create({
    model: MODEL,
    max_tokens: GEN_MAX_TOKENS,
    temperature: GEN_TEMPERATURE,
    system: [{ type: 'text', text: COLD_EMAIL_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
  });
  gen = GenSchema.parse(extractJSON(genMsg));

  const evalMsg = await claude.messages.create({
    model: MODEL,
    max_tokens: EVAL_MAX_TOKENS,
    temperature: EVAL_TEMPERATURE,
    system: [{ type: 'text', text: COLD_EMAIL_EVALUATOR_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Email body:\n${gen.body}\n\nProspect facts:\n${JSON.stringify({ lead, enrichment }, null, 2)}`,
    }],
  });
  const evalParsed = EvalSchema.parse(extractJSON(evalMsg));
  pct = evalParsed.personalization_pct;

  return { subject: gen.subject, body: gen.body, pct };
};

const baseLead = (overrides: Partial<Lead>): Lead => ({
  id: 'lead_test',
  source: 'gmaps',
  name: 'Test Facility',
  nameNormalized: 'test facility',
  street: null,
  city: 'City',
  state: 'ST',
  zip: null,
  addressHash: 'hash_test',
  phoneE164: null,
  website: 'https://example.com',
  googleRating: 4.5,
  googleReviews: 10,
  services: ['Residential'],
  sourceMeta: {},
  hubspotCompanyId: null,
  doNotContact: false,
  createdAt: new Date(),
  ...overrides,
});

const baseEnrichment = (overrides: Partial<Enrichment>): Enrichment => ({
  id: 'enr_test',
  leadId: 'lead_test',
  ownerName: null,
  ownerTitle: null,
  ownerEmail: null,
  ownerLinkedIn: null,
  teamSizeSignal: 'solo',
  expectedProduct: 'claimed',
  painPoints: {},
  signals: EMPTY_SIGNALS,
  legitscriptStatus: null,
  evidenceQuote: null,
  enrichedAt: new Date(),
  ...overrides,
});

const subjectWordCount = (subject: string): number =>
  subject.trim().split(/\s+/).filter((w) => w.length > 0).length;

describe('cold email — solo sober-living Asheville (claimed)', () => {
  afterEach(() => {
    setClaudeMock(null);
  });

  it('personalizes on Asheville, owner, and schema pain', async () => {
    const lead = baseLead({
      name: 'Blue Ridge Sober Living',
      city: 'Asheville',
      state: 'NC',
      googleReviews: 14,
      services: ['Sober Living'],
    });
    const enrichment = baseEnrichment({
      ownerName: 'Sarah Kim',
      ownerTitle: 'Owner',
      expectedProduct: 'claimed',
      painPoints: { no_schema_markup: true },
    });

    const { subject, body, pct } = await runColdEmailFlow(
      lead,
      enrichment,
      {
        subject: 'asheville sober living intake',
        body: [
          'Sarah, your Asheville sober living home has 14 Google reviews families trust.',
          'We connect families actively searching for a bed with centers that have open beds.',
          'Your site still lacks schema markup, so Asheville searches may not surface you clearly.',
          'Does this week or next work for a quick look at Asheville intake?',
        ].join(' '),
        specific_facts_used: ['Asheville', 'Sarah', 'schema'],
      },
      72,
    );

    expect(body).toMatch(/Asheville/i);
    expect(body).toMatch(/Sarah|Kim/);
    expect(pct).toBeGreaterThanOrEqual(60);
    expect(subjectWordCount(subject)).toBeLessThanOrEqual(6);
  });
});

describe('cold email — large Houston IOP (premium, hiring)', () => {
  afterEach(() => {
    setClaudeMock(null);
  });

  it('personalizes on Houston, IOP, and hiring signal', async () => {
    const lead = baseLead({
      name: 'Gulf Coast IOP',
      city: 'Houston',
      state: 'TX',
      googleReviews: 230,
      services: ['IOP', 'Outpatient'],
    });
    const enrichment = baseEnrichment({
      ownerName: null,
      expectedProduct: 'premium',
      painPoints: { weak_seo_title: true },
      signals: {
        ...EMPTY_SIGNALS,
        hiring: {
          active: true,
          roleTitles: ['Clinical Director', 'Intake Coordinator'],
          rolesPostedRecently: 2,
        },
      },
    });

    const { subject, body, pct } = await runColdEmailFlow(
      lead,
      enrichment,
      {
        subject: 'houston iop census pipeline',
        body: [
          'Your Houston IOP program shows up with 230 Google reviews, strong proof families trust you.',
          'We connect families actively searching for treatment with centers that have open beds.',
          'You are hiring a Clinical Director and Intake Coordinator, so keeping Houston intake full matters now.',
          'Given the hiring push, does Tuesday or Wednesday work for a brief census conversation?',
        ].join(' '),
        specific_facts_used: ['Houston', 'IOP', 'hiring'],
      },
      78,
    );

    expect(body).toMatch(/Houston/i);
    expect(body).toMatch(/IOP/i);
    expect(body).toMatch(/hiring|expanding/i);
    expect(pct).toBeGreaterThanOrEqual(60);
    expect(subjectWordCount(subject)).toBeLessThanOrEqual(6);
  });
});

describe('cold email — Cincinnati MAT clinic (select, directories)', () => {
  afterEach(() => {
    setClaudeMock(null);
  });

  it('personalizes on Cincinnati, Walsh, and directory gap', async () => {
    const lead = baseLead({
      name: 'Riverbend MAT Clinic',
      city: 'Cincinnati',
      state: 'OH',
      googleReviews: 8,
      services: ['MAT', 'Outpatient'],
    });
    const enrichment = baseEnrichment({
      ownerName: 'Dr. Marcus Walsh',
      ownerTitle: 'Medical Director',
      expectedProduct: 'select',
      painPoints: { no_outcomes_data: true },
      signals: {
        ...EMPTY_SIGNALS,
        competingDirectories: { onAnyDirectory: false, missingFromAll: true },
      },
    });

    const { subject, body, pct } = await runColdEmailFlow(
      lead,
      enrichment,
      {
        subject: 'cincinnati mat intake gap',
        body: [
          'Dr. Walsh, your Cincinnati MAT clinic serves a critical need with 8 Google reviews so far.',
          'We connect families actively searching for treatment with centers that have open beds.',
          'You are not on Psychology Today, so Cincinnati directory searches route to competitors instead of you.',
          'Would Tuesday or Thursday work to see what families in Cincinnati find when they search?',
        ].join(' '),
        specific_facts_used: ['MAT', 'Cincinnati', 'Walsh', 'Psychology Today'],
      },
      80,
    );

    expect(body).toMatch(/Cincinnati/i);
    expect(body).toMatch(/Walsh/i);
    expect(body).toMatch(/Psychology Today|directories|visible/i);
    expect(pct).toBeGreaterThanOrEqual(60);
    expect(subjectWordCount(subject)).toBeLessThanOrEqual(6);
  });
});
