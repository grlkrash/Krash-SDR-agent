import { serpapi, type SerpResult } from '../shared/serpapi.js';

export type ExpectedProduct = 'claimed' | 'select' | 'premium';

export type Signals = {
  competingDirectories: {
    onAnyDirectory: boolean;
    missingFromAll: boolean;
  };
  hiring: {
    active: boolean;
    roleTitles: string[];
    rolesPostedRecently: number;
  };
  techStack: {
    hubspot: boolean;
    salesforce: boolean;
    callrail: boolean;
    googleAds: boolean;
    facebookPixel: boolean;
    marketo: boolean;
    bigSpenderScore: number;
  };
};

const MAX_ROLE_TITLES = 5;
const HIRING_RESULT_LIMIT = 10;
const DIRECTORY_RESULT_LIMIT = 5;

const TECH_PATTERNS = {
  hubspot: /<script[^>]+src=[^>]*(?:js\.hs-scripts|js\.hsforms|js\.hsanalytics)/i,
  salesforce: /<script[^>]+src=[^>]*(?:salesforceliveagent|pardot\.com|force\.com)/i,
  callrail: /<script[^>]+src=[^>]*(?:callrail\.com|cdn\.callrail)/i,
  googleAds: /<script[^>]+src=[^>]*googleadservices\.com\/pagead\/conversion/i,
  facebookPixel: /<script[^>]+src=[^>]*connect\.facebook\.net/i,
  marketo: /<script[^>]+src=[^>]*munchkin\.marketo\.net/i,
} as const;

const anyResultMentionsName = (results: SerpResult[], name: string): boolean => {
  const needle = name.toLowerCase();
  return results.some((r) => {
    const haystack = `${r.title ?? ''} ${r.snippet ?? ''}`.toLowerCase();
    return haystack.includes(needle);
  });
};

const extractRoleTitles = (results: SerpResult[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of results) {
    const raw = r.title?.trim() ?? '';
    if (raw === '') continue;
    const role = raw.split(' - ')[0].trim();
    if (role === '') continue;
    const key = role.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(role);
    if (out.length >= MAX_ROLE_TITLES) break;
  }
  return out;
};

// One combined SerpAPI call across the three rehab directories, scoped via
// site: operators so we only get pages actually hosted on those domains.
const detectDirectories = async (
  facility: { name: string; city: string },
): Promise<Signals['competingDirectories']> => {
  const results = await serpapi(
    `"${facility.name}" ${facility.city} (site:psychologytoday.com OR site:rehabs.com OR site:recovery.com)`,
    DIRECTORY_RESULT_LIMIT,
  );
  const onAnyDirectory = anyResultMentionsName(results, facility.name);
  return {
    onAnyDirectory,
    missingFromAll: !onAnyDirectory,
  };
};

export const detectHiring = async (facility: { name: string }): Promise<Signals['hiring']> => {
  const results = await serpapi(
    `site:linkedin.com/jobs "${facility.name}"`,
    HIRING_RESULT_LIMIT,
  );
  return {
    active: results.length > 0,
    roleTitles: extractRoleTitles(results),
    rolesPostedRecently: results.length,
  };
};

const detectTechStack = (html: string): Signals['techStack'] => {
  const flags = {
    hubspot: TECH_PATTERNS.hubspot.test(html),
    salesforce: TECH_PATTERNS.salesforce.test(html),
    callrail: TECH_PATTERNS.callrail.test(html),
    googleAds: TECH_PATTERNS.googleAds.test(html),
    facebookPixel: TECH_PATTERNS.facebookPixel.test(html),
    marketo: TECH_PATTERNS.marketo.test(html),
  };
  const bigSpenderScore = Object.values(flags).filter(Boolean).length;
  return { ...flags, bigSpenderScore };
};

const EMPTY_HIRING: Signals['hiring'] = { active: false, roleTitles: [], rolesPostedRecently: 0 };

// Hiring is only worth a SerpAPI call on tiers we'll actually pursue with
// premium messaging. 'claimed' leads get a stub so we save the call.
export const detectSignals = async (
  facility: { name: string; city: string },
  html: string,
  expectedProduct: ExpectedProduct,
): Promise<Signals> => {
  const competingDirectories = await detectDirectories(facility);
  const hiring =
    expectedProduct === 'claimed' ? EMPTY_HIRING : await detectHiring(facility);
  const techStack = detectTechStack(html);
  return { competingDirectories, hiring, techStack };
};
