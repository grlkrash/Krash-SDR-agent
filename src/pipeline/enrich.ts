import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { claude, extractJSON } from '../shared/claude.js';
import { fetchSite } from '../shared/fetchSite.js';
import { findFacilityLeadership, findLinkedIn } from '../shared/serpapi.js';
import { WEBSITE_ANALYZER_SYSTEM, buildWebsiteAnalyzerUserPrompt } from '../prompts/websiteAnalyzer.js';
import { detectSignals, type Signals } from './signals.js';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });
// PRD/.cursorrules pin claude-sonnet-4-20250514 but Anthropic returns 404 for it as of May 2026.
// Using its 4.5 successor (matches the era of claude-haiku-4-5-20251001 already in the rules).
const ANALYZER_MODEL = 'claude-sonnet-4-5-20250929';
const TIERS = ['claimed', 'select', 'premium'] as const;
type Tier = (typeof TIERS)[number];

const EMPTY_SIGNALS: Signals = {
  competingDirectories: { psychologyToday: false, rehabsCom: false, recoveryCom: false, missingFromAll: false },
  hiring: { active: false, roleTitles: [], rolesPostedRecently: 0 },
  techStack: { hubspot: false, salesforce: false, callrail: false, googleAds: false, facebookPixel: false, marketo: false, bigSpenderScore: 0 },
};

const AnalyzerSchema = z.object({
  owner_or_clinical_director: z.object({
    name: z.string().nullable(), title: z.string().nullable(), evidence_quote: z.string().nullable(),
  }),
  team_size_signal: z.enum(['solo', 'small', 'medium', 'large', 'unknown']),
  expected_product: z.enum(['claimed', 'select', 'premium']),
  pain_points: z.record(z.string(), z.boolean()),
  services_listed: z.array(z.string()),
  insurance_listed: z.array(z.string()),
  estimated_bed_count: z.number().nullable(),
  legitscript_mentioned: z.boolean(),
});
type Analyzed = z.infer<typeof AnalyzerSchema>;

const writeStub = (leadId: string, painPoints: Prisma.InputJsonValue): Promise<unknown> =>
  prisma.enrichment.create({ data: {
    leadId, ownerName: null, ownerTitle: null, ownerLinkedIn: null, teamSizeSignal: null,
    expectedProduct: 'claimed', painPoints,
    signals: EMPTY_SIGNALS as unknown as Prisma.InputJsonValue,
    legitscriptStatus: null, evidenceQuote: null,
  } });

const bumpTier = (start: Tier, signals: Signals): Tier => {
  let idx = TIERS.indexOf(start);
  if (signals.techStack.bigSpenderScore >= 3) idx += 1;
  if (signals.hiring.active) idx += 1;
  return TIERS[Math.min(idx, TIERS.length - 1)];
};

const callAnalyzer = async (
  facility: { name: string; city: string; state: string }, html: string,
): Promise<Analyzed | null> => {
  const base = buildWebsiteAnalyzerUserPrompt(facility, html);
  const tryOnce = async (suffix: string): Promise<Analyzed | null> => {
    const msg = await claude.messages.create({
      model: ANALYZER_MODEL, max_tokens: 2048, temperature: 0,
      system: WEBSITE_ANALYZER_SYSTEM,
      messages: [{ role: 'user', content: base + suffix }],
    });
    try { return AnalyzerSchema.parse(extractJSON(msg)); } catch { return null; }
  };
  return (await tryOnce('')) ?? (await tryOnce('\n\nOutput ONLY raw JSON, no preamble, no fences.'));
};

export const enrichLead = async (leadId: string): Promise<void> => {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { enrichment: true } });
  if (!lead || lead.enrichment) return;
  if (lead.website === null) { await writeStub(leadId, { no_website: true }); return; }
  const fetched = await fetchSite(lead.website);
  if (!fetched) { await writeStub(leadId, { broken_or_slow: true }); return; }
  const analyzed = await callAnalyzer(lead, fetched.html);
  if (!analyzed) {
    await prisma.auditLog.create({ data: { action: 'enrich.claude.parse-failed', entity: 'lead', entityId: leadId, meta: {} } });
    return;
  }
  const signals = await detectSignals({ name: lead.name, city: lead.city }, fetched.html);
  let ownerName = analyzed.owner_or_clinical_director.name;
  let ownerTitle = analyzed.owner_or_clinical_director.title;
  let evidenceQuote = analyzed.owner_or_clinical_director.evidence_quote;
  let ownerLinkedIn: string | null = null;
  if (ownerName !== null) {
    ownerLinkedIn = await findLinkedIn(ownerName, lead.name, lead.city);
  } else {
    const fallback = await findFacilityLeadership(lead.name);
    if (fallback !== null) {
      ownerName = fallback.name;
      ownerTitle = fallback.title;
      ownerLinkedIn = fallback.linkedIn;
      evidenceQuote = null;
    }
  }
  await prisma.enrichment.create({ data: {
    leadId,
    ownerName,
    ownerTitle,
    ownerLinkedIn,
    teamSizeSignal: analyzed.team_size_signal,
    expectedProduct: bumpTier(analyzed.expected_product, signals),
    painPoints: analyzed.pain_points as Prisma.InputJsonValue,
    signals: signals as unknown as Prisma.InputJsonValue,
    legitscriptStatus: analyzed.legitscript_mentioned ? 'mentioned' : null,
    evidenceQuote,
  } });
};
