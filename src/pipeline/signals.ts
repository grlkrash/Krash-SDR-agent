import { serpapi, type SerpResult } from '../shared/serpapi.js';

export type Signals = {
  competingDirectories: {
    psychologyToday: boolean;
    rehabsCom: boolean;
    recoveryCom: boolean;
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

const TECH_PATTERNS = {
  hubspot: /<script[^>]+src=[^>]*(?:js\.hs-scripts|js\.hsforms|js\.hsanalytics)/i,
  salesforce: /<script[^>]+src=[^>]*(?:salesforceliveagent|pardot\.com|force\.com)/i,
  callrail: /<script[^>]+src=[^>]*(?:callrail\.com|cdn\.callrail)/i,
  googleAds: /<script[^>]+src=[^>]*googleadservices\.com\/pagead\/conversion/i,
  facebookPixel: /<script[^>]+src=[^>]*connect\.facebook\.net/i,
  marketo: /<script[^>]+src=[^>]*munchkin\.marketo\.net/i,
} as const;

const firstResultMentionsName = (results: SerpResult[], name: string): boolean => {
  if (results.length === 0) return false;
  const first = results[0];
  const haystack = `${first.title ?? ''} ${first.snippet ?? ''}`.toLowerCase();
  return haystack.includes(name.toLowerCase());
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

const detectDirectories = async (
  facility: { name: string; city: string },
): Promise<Signals['competingDirectories']> => {
  const q = (site: string): string =>
    `site:${site} "${facility.name}" ${facility.city}`;
  const [pt, rc, rec] = await Promise.all([
    serpapi(q('psychologytoday.com')),
    serpapi(q('rehabs.com')),
    serpapi(q('recovery.com')),
  ]);
  const psychologyToday = firstResultMentionsName(pt, facility.name);
  const rehabsCom = firstResultMentionsName(rc, facility.name);
  const recoveryCom = firstResultMentionsName(rec, facility.name);
  return {
    psychologyToday,
    rehabsCom,
    recoveryCom,
    missingFromAll: !psychologyToday && !rehabsCom && !recoveryCom,
  };
};

const detectHiring = async (facility: { name: string }): Promise<Signals['hiring']> => {
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

export const detectSignals = async (
  facility: { name: string; city: string },
  html: string,
): Promise<Signals> => {
  const competingDirectories = await detectDirectories(facility);
  const hiring = await detectHiring(facility);
  const techStack = detectTechStack(html);
  return { competingDirectories, hiring, techStack };
};
