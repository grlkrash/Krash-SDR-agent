// Sync a single Lead + Enrichment to HubSpot as Company (+ optional Contact).
//
// Skip semantics: if we can't derive a domain from lead.website we write a
// hubspotSync.skip.no-domain AuditLog row and throw — the signature is
// non-nullable on companyId, so callers (the cron script) catch the throw
// and count it as fail, but the AuditLog row makes the skip inspectable.
//
// Association API note: the HubSpot SDK v13 dropped the legacy
// hs.crm.companies.associationsApi surface. The PRD specified
// `[{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 1 }]` —
// but in the v4 association model, typeId 1 is the contact→company direction
// (HubSpot returns 400 INVALID_OBJECT_IDS when you call it as company→contact,
// verified against this portal 2026-05-25). We instead use
// hs.crm.associations.v4.basicApi.createDefault(...) which creates the
// standard bidirectional unlabeled company↔contact association — same on-wire
// effect as the legacy v3 helper the PRD assumed.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/companies/models/Filter.js';
import { hs, hsRetry } from '../shared/hubspot.js';
import { extractDomain } from '../shared/domain.js';
import { guessEmail } from '../shared/guessEmail.js';
import type { Signals } from './signals.js';

const PACING_MS = 100;
const SEARCH_LIMIT = 1;
// HubSpot's stock `industry` is a closed enum; the PRD wanted the literal
// 'Health Care: Addiction Treatment' but HubSpot rejects it with INVALID_OPTION
// (verified against this portal 2026-05-25). MENTAL_HEALTH_CARE is the closest
// allowed value; the addiction-treatment-specific categorization stays in our
// custom ss_* properties which are the actual source of truth for the SDR.
const DEFAULT_INDUSTRY = 'MENTAL_HEALTH_CARE';
const DEFAULT_LIFECYCLE_STAGE = 'lead';
const DEFAULT_EXPECTED_PRODUCT = 'claimed';
const DEFAULT_LEGITSCRIPT_STATUS = 'unknown';
const DEFAULT_LEAD_STATUS = 'NEW';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

type StringRecord = Record<string, string>;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Wrap every HubSpot call: retry on 429/502/503, then pace 100ms.
const paced = async <T>(fn: () => Promise<T>): Promise<T> => {
  const result = await hsRetry(fn);
  await sleep(PACING_MS);
  return result;
};

const splitName = (full: string | null): { firstname: string; lastname: string } => {
  if (full === null || full.trim() === '') return { firstname: '', lastname: '' };
  const parts = full.trim().split(/\s+/);
  const [firstname, ...rest] = parts;
  return { firstname: firstname ?? '', lastname: rest.join(' ') };
};

// Mapping is declared in display order so the rendered summary is stable
// across runs (e.g. always "HubSpot, CallRail" never "CallRail, HubSpot"
// for the same flags). Keyed on `keyof Signals['techStack']` to keep this
// in lockstep with src/pipeline/signals.ts at compile time.
const TECH_STACK_LABELS: Array<[keyof Signals['techStack'], string]> = [
  ['hubspot', 'HubSpot'],
  ['salesforce', 'Salesforce'],
  ['callrail', 'CallRail'],
  ['googleAds', 'Google Ads'],
  ['facebookPixel', 'Facebook Pixel'],
  ['marketo', 'Marketo'],
];

// Builds the human-readable call-prep string for the new
// ss_tech_stack_summary HubSpot Company property. We wrote `signals`
// ourselves in enrich.ts, but it round-trips through a Prisma JSON column
// so we narrow defensively from `unknown` rather than trust the shape.
// Returns '' (not null) when nothing is detected — matches the empty-string
// convention used by sibling ss_* writes (e.g. ss_google_rating).
const buildTechStackSummary = (signals: unknown): string => {
  if (typeof signals !== 'object' || signals === null) return '';
  const techStack = (signals as { techStack?: unknown }).techStack;
  if (typeof techStack !== 'object' || techStack === null) return '';
  const flags = techStack as Partial<Record<keyof Signals['techStack'], unknown>>;
  const detected = TECH_STACK_LABELS
    .filter(([key]) => flags[key] === true)
    .map(([, label]) => label);
  if (detected.length === 0) return '';
  const noun = detected.length === 1 ? 'tool' : 'tools';
  return `${detected.join(', ')} (${detected.length} ${noun})`;
};

const buildCompanyProperties = (
  lead: {
    name: string;
    city: string;
    state: string;
    phoneE164: string | null;
    source: string;
    googleRating: number | null;
    googleReviews: number | null;
  },
  enrichment: {
    expectedProduct: string | null;
    painPoints: unknown;
    signals: unknown;
    legitscriptStatus: string | null;
  },
  domain: string,
): StringRecord => ({
  name: lead.name,
  domain,
  city: lead.city,
  state: lead.state,
  phone: lead.phoneE164 ?? '',
  industry: DEFAULT_INDUSTRY,
  lifecyclestage: DEFAULT_LIFECYCLE_STAGE,
  ss_source: lead.source,
  ss_google_rating: lead.googleRating?.toString() ?? '',
  ss_google_reviews: lead.googleReviews?.toString() ?? '',
  ss_expected_product: enrichment.expectedProduct ?? DEFAULT_EXPECTED_PRODUCT,
  ss_pain_points: JSON.stringify(enrichment.painPoints),
  ss_signals: JSON.stringify(enrichment.signals),
  ss_tech_stack_summary: buildTechStackSummary(enrichment.signals),
  ss_legitscript_status: enrichment.legitscriptStatus ?? DEFAULT_LEGITSCRIPT_STATUS,
});

const findCompanyByDomain = async (domain: string): Promise<string | null> => {
  const res = await paced(() =>
    hs.crm.companies.searchApi.doSearch({
      filterGroups: [{
        filters: [{ propertyName: 'domain', operator: FilterOperatorEnum.Eq, value: domain }],
      }],
      properties: ['domain'],
      limit: SEARCH_LIMIT,
    }),
  );
  return res.results[0]?.id ?? null;
};

const upsertCompany = async (properties: StringRecord, domain: string): Promise<string> => {
  const existingId = await findCompanyByDomain(domain);
  if (existingId !== null) {
    const updated = await paced(() =>
      hs.crm.companies.basicApi.update(existingId, { properties }),
    );
    return updated.id;
  }
  const created = await paced(() =>
    hs.crm.companies.basicApi.create({ properties }),
  );
  return created.id;
};

const findContactByEmail = async (email: string): Promise<string | null> => {
  const res = await paced(() =>
    hs.crm.contacts.searchApi.doSearch({
      filterGroups: [{
        filters: [{ propertyName: 'email', operator: FilterOperatorEnum.Eq, value: email }],
      }],
      properties: ['email'],
      limit: SEARCH_LIMIT,
    }),
  );
  return res.results[0]?.id ?? null;
};

const upsertContact = async (properties: StringRecord, email: string): Promise<string> => {
  const existingId = await findContactByEmail(email);
  if (existingId !== null) {
    const updated = await paced(() =>
      hs.crm.contacts.basicApi.update(existingId, { properties }),
    );
    return updated.id;
  }
  const created = await paced(() =>
    hs.crm.contacts.basicApi.create({ properties }),
  );
  return created.id;
};

const associateContactWithCompany = async (
  companyId: string,
  contactId: string,
): Promise<void> => {
  await paced(() =>
    hs.crm.associations.v4.basicApi.createDefault(
      'companies',
      companyId,
      'contacts',
      contactId,
    ),
  );
};

export const syncLeadToHubspot = async (
  leadId: string,
): Promise<{ companyId: string; contactId: string | null }> => {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { enrichment: true },
  });
  if (lead === null) throw new Error(`hubspotSync: lead not found: ${leadId}`);
  const enrichment = lead.enrichment;
  if (enrichment === null) throw new Error(`hubspotSync: enrichment missing for ${leadId}`);

  const domain = extractDomain(lead.website);
  if (domain === null) {
    await prisma.auditLog.create({ data: {
      action: 'hubspotSync.skip.no-domain',
      entity: 'lead',
      entityId: leadId,
      meta: { website: lead.website },
    } });
    throw new Error(`hubspotSync.skip: no domain extractable from website for ${leadId}`);
  }

  const companyProps = buildCompanyProperties(lead, enrichment, domain);
  const companyId = await upsertCompany(companyProps, domain);

  let contactId: string | null = null;
  const email = enrichment.ownerEmail ?? guessEmail(enrichment.ownerName, lead.website);
  if (email !== null) {
    const { firstname, lastname } = splitName(enrichment.ownerName);
    const contactProps: StringRecord = {
      email,
      firstname,
      lastname,
      jobtitle: enrichment.ownerTitle ?? '',
      hs_lead_status: DEFAULT_LEAD_STATUS,
      ss_linkedin_url: enrichment.ownerLinkedIn ?? '',
    };
    contactId = await upsertContact(contactProps, email);
    await associateContactWithCompany(companyId, contactId);
  }

  await prisma.lead.update({
    where: { id: leadId },
    data: { hubspotCompanyId: companyId },
  });

  return { companyId, contactId };
};
