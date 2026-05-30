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
import { assessColdEmailQuality } from '../../src/outreach/coldEmailQuality.js';

const MODEL = 'claude-sonnet-4-5-20250929';
const GEN_MAX_TOKENS = 1536;
const GEN_TEMPERATURE = 0.7;
const EVAL_MAX_TOKENS = 768;
const EVAL_TEMPERATURE = 0.3;

const GenSchema = z.object({
  subject: z.string(),
  body: z.string(),
  specific_facts_used: z.array(z.string()),
});

const EvalSchema = z.object({
  personalization_pct: z.number(),
  generic_sentences: z.array(z.string()).default([]),
  has_market_pain_context: z.boolean().default(true),
  has_ss_product_context: z.boolean().default(true),
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
        has_market_pain_context: true,
        has_ss_product_context: true,
        word_count: genPayload.body.split(/\s+/).length,
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

describe('buildColdEmailUser', () => {
  it('includes market pain hint for select tier', () => {
    const lead = baseLead({ city: 'Houston', state: 'TX' });
    const enrichment = baseEnrichment({ expectedProduct: 'select' });
    const prompt = buildColdEmailUser(lead, enrichment);
    expect(prompt).toMatch(/124%/);
    expect(prompt).toMatch(/SS IDENTITY/i);
  });
});

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

    const body = [
      'Sarah, your Asheville sober living home has 14 Google reviews families trust, and families searching Buncombe County often miss operators your size.',
      'Most small sober living homes have only a handful of channels to reach families online, and those keep getting pricier or harder to access in North Carolina.',
      'That makes every aligned inquiry count when you are trying to keep beds full in Asheville.',
      'Sobriety Select is a map-forward directory where families search by region and insurance, not keyword bids.',
      'Partnership means a complete profile with services, photos, and verified reviews so inquiries are better aligned, plus a channel that complements your existing outreach without another paid-search auction.',
      'Does this week or next work for a quick look at what families in Asheville see when they search for sober living?',
    ].join(' ');

    const { subject, body: outBody, pct } = await runColdEmailFlow(
      lead,
      enrichment,
      {
        subject: 'asheville sober living intake',
        body,
        specific_facts_used: ['Asheville', 'Sarah', 'schema', '14 reviews'],
      },
      72,
    );

    expect(outBody).toMatch(/Asheville/i);
    expect(outBody).toMatch(/Sarah|Kim/);
    expect(outBody).toMatch(/Sobriety Select/i);
    expect(pct).toBeGreaterThanOrEqual(60);
    expect(subjectWordCount(subject)).toBeLessThanOrEqual(6);
    expect(assessColdEmailQuality(outBody).ok).toBe(true);
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
        techStack: { ...EMPTY_SIGNALS.techStack, googleAds: true, bigSpenderScore: 3 },
      },
    });

    const body = [
      'Your Houston IOP program shows 230 Google reviews, strong proof families trust you, and you are hiring a Clinical Director and Intake Coordinator to support growth.',
      'Paid search for drug rehab facility keywords is up 124% year over year, and drug rehab terms up 62%, so Houston operators compete on the same expensive auctions while trying to fill new intake capacity.',
      'That pressure makes census harder to predict even for strong programs like Gulf Coast IOP.',
      'Sobriety Select is a map-forward directory where families search by region and insurance, not keyword bids.',
      'Partnership means rich profiles with insurance, services, and verified reviews so inquiries are better aligned, plus lead capture that complements your existing Google Ads spend without another bidding war.',
      'Given the hiring push, does Tuesday or Wednesday work for a brief census conversation about what Houston families see when they search?',
    ].join(' ');

    const { subject, body: outBody, pct } = await runColdEmailFlow(
      lead,
      enrichment,
      {
        subject: 'houston iop census pipeline',
        body,
        specific_facts_used: ['Houston', 'IOP', 'hiring', '124%'],
      },
      78,
    );

    expect(outBody).toMatch(/Houston/i);
    expect(outBody).toMatch(/IOP/i);
    expect(outBody).toMatch(/hiring|expanding/i);
    expect(outBody).toMatch(/124%/);
    expect(pct).toBeGreaterThanOrEqual(60);
    expect(subjectWordCount(subject)).toBeLessThanOrEqual(6);
    expect(assessColdEmailQuality(outBody).ok).toBe(true);
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

    const body = [
      'Dr. Walsh, your Cincinnati MAT clinic serves a critical need with 8 Google reviews so far, and you are not on Psychology Today so directory searches in Cincinnati route to competitors instead of you.',
      'Paid search for drug rehab terms is up 62% year over year, and most MAT operators have only a few places they can advertise to reach families searching in Ohio.',
      'That makes it harder to build a steady intake pipeline even when your clinical program is strong.',
      'Sobriety Select is a map-forward directory where families search by region and insurance, not keyword proximity alone.',
      'Partnership means a complete profile with insurance, program details, and verified reviews so inquiries are better aligned, plus regional discovery that complements your existing outreach.',
      'Would Tuesday or Thursday work to see what families in Cincinnati find when they search for MAT treatment?',
    ].join(' ');

    const { subject, body: outBody, pct } = await runColdEmailFlow(
      lead,
      enrichment,
      {
        subject: 'cincinnati mat intake gap',
        body,
        specific_facts_used: ['MAT', 'Cincinnati', 'Walsh', 'Psychology Today'],
      },
      80,
    );

    expect(outBody).toMatch(/Cincinnati/i);
    expect(outBody).toMatch(/Walsh/i);
    expect(outBody).toMatch(/Psychology Today|directories|visible/i);
    expect(pct).toBeGreaterThanOrEqual(60);
    expect(subjectWordCount(subject)).toBeLessThanOrEqual(6);
    expect(assessColdEmailQuality(outBody).ok).toBe(true);
  });
});
