// Ad-hoc facility intel: name or website → scrape, enrich, prep brief.
// No HubSpot reads/writes — for demo prep on SS-sourced prospects.

import { createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, type Enrichment, type Lead } from '@prisma/client';
import { z } from 'zod';
import { generatePrepBriefIntel } from '../outreach/prepBrief.js';
import { extractDomain } from '../shared/domain.js';
import { fetchSite } from '../shared/fetchSite.js';
import { normalizeName, toE164 } from '../shared/lead.js';
import { enrichLead } from './enrich.js';
import { lookupDirectoryForFacility, type DirectorySearchHit } from './exclusions/fetchDirectoryApi.js';
import { lookupPlace } from './placesLookup.js';
import { detectSignals, type Signals } from './signals.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

export const IntelInputSchema = z.object({
  name: z.string().trim().optional(),
  website: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  refresh: z.boolean().optional(),
});

export type IntelInput = z.infer<typeof IntelInputSchema>;

export type IntelLookupResult = {
  leadId: string;
  leadName: string;
  website: string | null;
  city: string;
  state: string;
  googleRating: number | null;
  googleReviews: number | null;
  directoryHits: DirectorySearchHit[];
  enrichment: Enrichment;
  prepBriefMarkdown: string;
};

type ResolvedIntel = {
  name: string;
  website: string | null;
  city: string;
  state: string;
  zip: string | null;
  street: string | null;
  phone: string | null;
  googleRating: number | null;
  googleReviews: number | null;
};

const normalizeWebsite = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const buildIntelAddressHash = (
  website: string | null,
  city: string,
  state: string,
): string => {
  const domain = extractDomain(website) ?? '';
  const key = `${domain}|${city.toLowerCase()}|${state.toLowerCase()}`;
  return createHash('sha256').update(key).digest('hex');
};

const findExistingLead = async (
  website: string | null,
  nameNormalized: string,
  addressHash: string,
): Promise<Lead | null> => {
  const domain = extractDomain(website);
  if (domain !== null) {
    const byDomain = await prisma.lead.findFirst({
      where: { website: { contains: domain, mode: 'insensitive' } },
      orderBy: { createdAt: 'desc' },
    });
    if (byDomain !== null) return byDomain;
  }
  return prisma.lead.findUnique({
    where: { nameNormalized_addressHash: { nameNormalized, addressHash } },
  });
};

const upsertIntelLead = async (resolved: ResolvedIntel): Promise<Lead> => {
  const nameNormalized = normalizeName(resolved.name);
  const addrHash = buildIntelAddressHash(resolved.website, resolved.city, resolved.state);
  const row = {
    source: 'intel',
    name: resolved.name,
    nameNormalized,
    street: resolved.street,
    city: resolved.city,
    state: resolved.state,
    zip: resolved.zip,
    addressHash: addrHash,
    phoneE164: toE164(resolved.phone),
    website: resolved.website,
    googleRating: resolved.googleRating,
    googleReviews: resolved.googleReviews,
    services: [] as string[],
    sourceMeta: { intelLookup: true } as Prisma.InputJsonValue,
  };
  return prisma.lead.upsert({
    where: { nameNormalized_addressHash: { nameNormalized, addressHash: addrHash } },
    create: row,
    update: {
      name: row.name,
      street: row.street,
      city: row.city,
      state: row.state,
      zip: row.zip,
      phoneE164: row.phoneE164,
      website: row.website,
      googleRating: row.googleRating,
      googleReviews: row.googleReviews,
      sourceMeta: row.sourceMeta,
    },
  });
};

const supplementIntelSignals = async (leadId: string): Promise<void> => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null || lead.enrichment === null) return;

  let html = '';
  if (lead.website !== null) {
    const fetched = await fetchSite(lead.website);
    html = fetched?.html ?? '';
  }
  const signals = await detectSignals({ name: lead.name, city: lead.city }, html, 'select');
  await prisma.enrichment.update({
    where: { leadId },
    data: { signals: signals as unknown as Prisma.InputJsonValue },
  });
};

const ensureIntelEnrichment = async (leadId: string, refresh: boolean): Promise<Enrichment> => {
  if (refresh) await prisma.enrichment.deleteMany({ where: { leadId } });

  const existing = await prisma.enrichment.findUnique({ where: { leadId } });
  if (existing !== null) return existing;

  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (lead === null) throw new Error(`Lead not found: ${leadId}`);

  if (lead.website !== null) {
    await enrichLead(leadId);
  } else {
    const signals = await detectSignals({ name: lead.name, city: lead.city }, '', 'select');
    await prisma.enrichment.create({
      data: {
        leadId,
        ownerName: null,
        ownerTitle: null,
        ownerLinkedIn: null,
        teamSizeSignal: null,
        expectedProduct: signals.hiring.active ? 'select' : 'claimed',
        painPoints: { no_website: true },
        signals: signals as unknown as Prisma.InputJsonValue,
        legitscriptStatus: null,
        evidenceQuote: null,
      },
    });
  }

  await supplementIntelSignals(leadId);
  const enriched = await prisma.enrichment.findUnique({ where: { leadId } });
  if (enriched === null) throw new Error(`Enrichment failed for ${leadId}`);
  return enriched;
};

const mergePlaces = (
  base: ResolvedIntel,
  place: NonNullable<Awaited<ReturnType<typeof lookupPlace>>>,
): ResolvedIntel => ({
  ...base,
  name: base.name.startsWith('Unknown') || base.name === extractDomain(base.website)
    ? place.name
    : base.name,
  street: base.street ?? place.street,
  city: base.city === 'Unknown' ? place.city : base.city,
  state: base.state === 'XX' ? place.state : base.state,
  zip: base.zip ?? place.zip,
  phone: base.phone ?? place.phone,
  website: base.website ?? place.website,
  googleRating: base.googleRating ?? place.googleRating,
  googleReviews: base.googleReviews ?? place.googleReviews,
});

const resolveIntelInput = async (input: IntelInput): Promise<ResolvedIntel> => {
  const nameInput = input.name ?? '';
  const websiteRaw = input.website ?? '';
  const websiteInput = websiteRaw !== '' ? normalizeWebsite(websiteRaw) : null;

  if (nameInput === '' && websiteInput === null) {
    throw new Error('Enter a facility name or website URL.');
  }

  const domainFallback = websiteInput !== null ? extractDomain(websiteInput) : null;
  let resolved: ResolvedIntel = {
    name: nameInput !== '' ? nameInput : domainFallback ?? 'Unknown facility',
    website: websiteInput,
    city: input.city?.trim() || 'Unknown',
    state: input.state?.trim() || 'XX',
    zip: null,
    street: null,
    phone: null,
    googleRating: null,
    googleReviews: null,
  };

  const placeQuery = nameInput !== '' ? nameInput : domainFallback ?? websiteInput ?? '';
  if (placeQuery !== '') {
    const place = await lookupPlace(placeQuery, resolved.city, resolved.state);
    if (place !== null) resolved = mergePlaces(resolved, place);
  }

  if (resolved.name === 'Unknown facility' && domainFallback !== null) {
    resolved.name = domainFallback;
  }

  return resolved;
};

export const runIntelLookup = async (input: IntelInput): Promise<IntelLookupResult> => {
  const refresh = input.refresh !== false;
  const resolved = await resolveIntelInput(input);

  const nameNormalized = normalizeName(resolved.name);
  const addrHash = buildIntelAddressHash(resolved.website, resolved.city, resolved.state);

  let lead = await findExistingLead(resolved.website, nameNormalized, addrHash);

  if (lead === null) {
    lead = await upsertIntelLead(resolved);
  } else {
    lead = await prisma.lead.update({
      where: { id: lead.id },
      data: {
        name: resolved.name,
        website: resolved.website ?? lead.website,
        phoneE164: toE164(resolved.phone) ?? lead.phoneE164,
        googleRating: resolved.googleRating ?? lead.googleRating,
        googleReviews: resolved.googleReviews ?? lead.googleReviews,
        city: resolved.city !== 'Unknown' ? resolved.city : lead.city,
        state: resolved.state !== 'XX' ? resolved.state : lead.state,
      },
    });
  }

  const directoryHits = await lookupDirectoryForFacility({
    name: resolved.name,
    website: resolved.website,
    city: resolved.city,
    state: resolved.state,
  });
  const enrichment = await ensureIntelEnrichment(lead.id, refresh);
  const { markdown } = await generatePrepBriefIntel(lead.id);

  await prisma.auditLog.create({
    data: {
      action: 'intel.lookup',
      entity: 'lead',
      entityId: lead.id,
      meta: {
        refresh,
        directoryHitCount: directoryHits.length,
        expectedProduct: enrichment.expectedProduct,
        website: resolved.website,
      },
    },
  });

  const finalLead = await prisma.lead.findUnique({ where: { id: lead.id } });
  if (finalLead === null) throw new Error(`Lead missing after intel lookup: ${lead.id}`);

  return {
    leadId: finalLead.id,
    leadName: finalLead.name,
    website: finalLead.website,
    city: finalLead.city,
    state: finalLead.state,
    googleRating: finalLead.googleRating,
    googleReviews: finalLead.googleReviews,
    directoryHits,
    enrichment,
    prepBriefMarkdown: markdown,
  };
};

export const parseSignals = (raw: unknown): Signals | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Partial<Signals>;
  if (s.competingDirectories === undefined || s.hiring === undefined || s.techStack === undefined) {
    return null;
  }
  return s as Signals;
};
