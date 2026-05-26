// Pipeline scoring: rank every open HubSpot deal by recency + tier value.
//
// The score formula and weights come straight from PRD §7.1. A few notes on
// the inputs we choose:
//
//  * `notes_last_contacted` is the HubSpot-native "last touch" timestamp,
//    written by HubSpot any time we log an email/call engagement against a
//    deal's associated contact. It's the cleanest "is this lead going cold?"
//    signal we have without paid history endpoints.
//  * `hs_lastmodifieddate` is used as a stage-age proxy because real stage
//    transition history lives behind Sales Hub Enterprise. Any stage move
//    bumps lastmodifieddate, so it's a strict upper bound on "time in stage"
//    — i.e. we under-penalize stalled deals (safe direction), never over.
//  * `hs_email_last_open_date` is portal-wide; a 48h window is short enough
//    that we won't double-count opens from old sequences.
//
// Scores are clamped to [0,100] and persisted to the Score table. The /queue
// view and dailyBrief later read the most-recent Score row per deal.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/deals/models/Filter.js';
import { hs, hsRetry } from '../shared/hubspot.js';

const COMMISSION_BY_PRODUCT: Record<string, number> = {
  'claimed': 60, 'select': 240, 'premium': 960,
  'seo': 900, 'social': 600, 'ppc': 900, 'upsell-bundle': 1250,
};

// Display labels for the per-deal tier callout reason. Keyed identically to
// COMMISSION_BY_PRODUCT so adding a new tier requires touching both maps
// (deliberate — keeps commission and label in lockstep).
const PRODUCT_LABELS: Record<string, string> = {
  'claimed': 'Claimed-tier prospect',
  'select': 'Select-tier prospect',
  'premium': 'Premium-tier prospect',
  'seo': 'SEO upsell',
  'social': 'Social upsell',
  'ppc': 'PPC upsell',
  'upsell-bundle': 'Upsell bundle',
};

const DEFAULT_COMMISSION = 240;
const DEFAULT_PRODUCT_LABEL = 'Unknown tier';

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 60 * 60 * 1000;
const EMAIL_OPEN_WINDOW_MS = 48 * MS_PER_HOUR;

const SCORE_BASE = 50;
const SCORE_MIN = 0;
const SCORE_MAX = 100;
const RECENT_CONTACT_DAYS = 2;
const STALE_CONTACT_DAYS = 7;
const STALE_STAGE_DAYS = 14;
const RECENT_CONTACT_BONUS = 10;
const EMAIL_OPEN_BONUS = 15;
const STALE_CONTACT_PENALTY_PER_DAY = 2;
const NO_CONTACT_SENTINEL_DAYS = 999;

const PAGE_SIZE = 100;
const PACING_MS = 100;

const DEAL_PROPERTIES = [
  'dealname',
  'dealstage',
  'amount',
  'hs_lastmodifieddate',
  'notes_last_contacted',
  'hs_email_last_open_date',
  'ss_product_type',
  'hubspot_owner_id',
];

const CLOSED_STAGES = ['closedwon', 'closedlost'];

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// HubSpot ships date properties back as ISO strings on most v3 endpoints
// (e.g. "2026-05-20T14:33:00Z"), but a few legacy/system properties still
// arrive as Unix-ms strings. Try ISO first, fall back to numeric. Returns
// null for null/empty/unparseable input so downstream code can branch on
// "we have a timestamp" vs. "we don't" without sentinel-value land mines.
const parseHsDate = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined || raw === '') return null;
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso)) return iso;
  const num = Number(raw);
  if (!Number.isNaN(num) && num > 0) return num;
  return null;
};

// Build the "Email opened …" reason at the granularity that reads natural:
// sub-hour, sub-day, "yesterday", or "Nd ago". Window is bounded by
// EMAIL_OPEN_WINDOW_MS so daysAgo never exceeds 2.
const emailOpenedLabel = (openedAtMs: number, nowMs: number): string => {
  const hoursAgo = Math.round((nowMs - openedAtMs) / MS_PER_HOUR);
  if (hoursAgo < 1) return 'Email opened in the last hour';
  if (hoursAgo < 24) return `Email opened ${hoursAgo}h ago`;
  const daysAgo = Math.round(hoursAgo / 24);
  if (daysAgo === 1) return 'Email opened yesterday';
  return `Email opened ${daysAgo}d ago`;
};

interface DealScore {
  score: number;
  expectedCommission: number;
  reasons: Array<string>;
}

const computeDealScore = (
  properties: Record<string, string | null>,
  now: number,
): DealScore => {
  const reasons: Array<string> = [];
  let score = SCORE_BASE;

  const lastContactMs = parseHsDate(properties.notes_last_contacted);
  const daysSinceContact = lastContactMs === null
    ? NO_CONTACT_SENTINEL_DAYS
    : (now - lastContactMs) / MS_PER_DAY;

  if (daysSinceContact > STALE_CONTACT_DAYS) {
    score -= (daysSinceContact - STALE_CONTACT_DAYS) * STALE_CONTACT_PENALTY_PER_DAY;
    reasons.push(
      lastContactMs === null
        ? 'Never contacted'
        : `Last contact ${Math.round(daysSinceContact)}d ago`,
    );
  }
  if (daysSinceContact < RECENT_CONTACT_DAYS) {
    score += RECENT_CONTACT_BONUS;
    reasons.push('Contacted in the last 48h');
  }

  const stageModMs = parseHsDate(properties.hs_lastmodifieddate);
  if (stageModMs !== null) {
    const stageAge = (now - stageModMs) / MS_PER_DAY;
    if (stageAge > STALE_STAGE_DAYS) {
      score -= (stageAge - STALE_STAGE_DAYS);
      reasons.push(`Stalled ${Math.round(stageAge)}d in stage`);
    }
  }

  const lastOpenMs = parseHsDate(properties.hs_email_last_open_date);
  if (lastOpenMs !== null && (now - lastOpenMs) <= EMAIL_OPEN_WINDOW_MS) {
    score += EMAIL_OPEN_BONUS;
    reasons.push(emailOpenedLabel(lastOpenMs, now));
  }

  const clamped = Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(score)));

  const productType = properties.ss_product_type ?? '';
  const expectedCommission = COMMISSION_BY_PRODUCT[productType] ?? DEFAULT_COMMISSION;
  const productLabel = PRODUCT_LABELS[productType] ?? DEFAULT_PRODUCT_LABEL;
  reasons.push(`${productLabel} — $${expectedCommission} commission`);

  return { score: clamped, expectedCommission, reasons };
};

const fetchOpenDealsPage = async (
  after: string | undefined,
): Promise<Awaited<ReturnType<typeof hs.crm.deals.searchApi.doSearch>>> =>
  hsRetry(() => hs.crm.deals.searchApi.doSearch({
    filterGroups: [{
      filters: [{
        propertyName: 'dealstage',
        operator: FilterOperatorEnum.NotIn,
        values: CLOSED_STAGES,
      }],
    }],
    properties: DEAL_PROPERTIES,
    limit: PAGE_SIZE,
    after: after ?? '',
  }));

export const scoreAllDeals = async (): Promise<void> => {
  const now = Date.now();
  let after: string | undefined = undefined;

  while (true) {
    const res = await fetchOpenDealsPage(after);
    for (const deal of res.results) {
      const { score, expectedCommission, reasons } = computeDealScore(deal.properties, now);
      await prisma.score.create({
        data: {
          hubspotDealId: deal.id,
          score,
          expectedCommission,
          reasons,
        },
      });
    }
    const next = res.paging?.next?.after;
    if (next === undefined || next === '') break;
    after = next;
    await sleep(PACING_MS);
  }
};
