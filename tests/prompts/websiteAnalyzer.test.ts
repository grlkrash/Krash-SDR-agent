import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { setClaudeMock } from '../../src/shared/claude.js';
import { enrichLead } from '../../src/pipeline/enrich.js';
import { upsertLead } from '../../src/shared/lead.js';
import { fetchSite } from '../../src/shared/fetchSite.js';

vi.mock('../../src/shared/fetchSite.js', () => ({
  fetchSite: vi.fn(),
}));

vi.mock('../../src/pipeline/signals.js', () => ({
  detectSignals: vi.fn(async () => ({
    competingDirectories: { onAnyDirectory: false, missingFromAll: false },
    hiring: { active: false, roleTitles: [], rolesPostedRecently: 0 },
    techStack: {
      hubspot: false,
      salesforce: false,
      callrail: false,
      googleAds: false,
      facebookPixel: false,
      marketo: false,
      bigSpenderScore: 0,
    },
  })),
}));

vi.mock('../../src/shared/serpapi.js', () => ({
  findLinkedIn: vi.fn(async () => null),
  findFacilityLeadership: vi.fn(async () => null),
}));

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const ALL_PAIN_POINTS = {
  thin_about_page: false,
  no_team_photos: false,
  stock_photography_only: false,
  no_outcomes_data: false,
  broken_or_no_https: false,
  no_schema_markup: false,
  no_reviews_mentioned: false,
  weak_seo_title: false,
} as const;

const mockAnalyzerMessage = (payload: unknown) => ({
  id: 'msg_analyzer',
  type: 'message' as const,
  role: 'assistant' as const,
  model: 'claude-sonnet-4-5-20250929',
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  stop_reason: 'end_turn' as const,
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
});

describe('website analyzer — clean center site', () => {
  let leadId: string;

  beforeEach(async () => {
    setClaudeMock(null);
    const lead = await upsertLead({
      source: 'gmaps',
      name: `Golden Clean Center ${Date.now()}`,
      street: '100 Main St',
      city: 'Austin',
      state: 'TX',
      zip: '78701',
      phone: null,
      website: 'https://clean-center.example',
      googleRating: 4.2,
      googleReviews: 40,
      services: ['Residential', 'IOP'],
      sourceMeta: { test: 'websiteAnalyzer-clean' },
    });
    leadId = lead.id;
  });

  afterEach(async () => {
    setClaudeMock(null);
    if (leadId !== undefined) {
      await prisma.lead.delete({ where: { id: leadId } }).catch(() => undefined);
    }
  });

  it('writes enrichment with owner and select tier from analyzer', async () => {
    vi.mocked(fetchSite).mockResolvedValue({
      html: '<html><body><h1>Clean Center</h1><p>Jane Doe, Executive Director</p></body></html>',
      finalUrl: 'https://clean-center.example',
    });

    setClaudeMock(async () =>
      mockAnalyzerMessage({
        owner_or_clinical_director: {
          name: 'Jane Doe',
          title: 'Executive Director',
          evidence_quote: 'Jane Doe, Executive Director',
        },
        team_size_signal: 'small',
        expected_product: 'select',
        pain_points: { ...ALL_PAIN_POINTS },
        services_listed: ['Residential', 'IOP'],
        insurance_listed: ['Aetna'],
        estimated_bed_count: 32,
        legitscript_mentioned: false,
      }),
    );

    await enrichLead(leadId);

    const enrichment = await prisma.enrichment.findUnique({ where: { leadId } });
    expect(enrichment).not.toBeNull();
    expect(enrichment?.ownerName).toBe('Jane Doe');
    expect(enrichment?.expectedProduct).toBe('select');
    expect(enrichment?.teamSizeSignal).toBe('small');
  });
});

describe('website analyzer — broken site', () => {
  let leadId: string;

  beforeEach(async () => {
    setClaudeMock(null);
    const lead = await upsertLead({
      source: 'gmaps',
      name: `Golden Broken Site ${Date.now()}`,
      street: '200 Fail Ln',
      city: 'Dallas',
      state: 'TX',
      zip: '75201',
      phone: null,
      website: 'https://broken-site.example',
      googleRating: null,
      googleReviews: null,
      services: [],
      sourceMeta: { test: 'websiteAnalyzer-broken' },
    });
    leadId = lead.id;
  });

  afterEach(async () => {
    setClaudeMock(null);
    if (leadId !== undefined) {
      await prisma.lead.delete({ where: { id: leadId } }).catch(() => undefined);
    }
  });

  it('writes stub enrichment with broken_or_slow when fetch returns null', async () => {
    vi.mocked(fetchSite).mockResolvedValue(null);

    let claudeCalls = 0;
    setClaudeMock(async () => {
      claudeCalls += 1;
      return mockAnalyzerMessage({});
    });

    await enrichLead(leadId);

    expect(claudeCalls).toBe(0);

    const enrichment = await prisma.enrichment.findUnique({ where: { leadId } });
    expect(enrichment).not.toBeNull();
    expect(enrichment?.expectedProduct).toBe('claimed');
    const painPoints = enrichment?.painPoints as Record<string, boolean>;
    expect(painPoints.broken_or_slow).toBe(true);
    expect(enrichment?.ownerName).toBeNull();
  });
});
