// SDR daily brief.
//
// One markdown email per day to Sonia. Pulls the latest Score per deal in the
// last 24h, ranks by score × commission, surfaces top hot leads, top stalled
// risk, and a phone-friendly call list with a coarse TZ hint. The v1.2
// addition is the 📬 New replies block at the top: replies are warm inbound
// intent and the highest-leverage signal in the brief, so the section is
// pinned ABOVE hot leads and the count is prefixed onto the subject line so
// Sonia can triage from the inbox preview alone.
//
// Data joins:
//   Score → hubspotDealId; there is no FK to Lead. We resolve dealId →
//   companyId by fetching each deal with the 'companies' association, then
//   look up Lead via Lead.hubspotCompanyId. The HubSpot working set is
//   bounded to the union of hot + at-risk + call-list candidate IDs (≤ ~30)
//   so the daily API budget stays cheap.
//
//   Inbound reply snippet: preferred source is AuditLog
//   'reply.draft-created' meta.inboundSnippet (written by replyWatcher when
//   the draft is created — see INSTRUCTIONS Prompt 7.3). Falls back to
//   HubSpot `emails.basicApi.getById(['hs_email_text'])` keyed on
//   `Draft.hubspotInboundEmailId` for historical drafts written before
//   the audit-meta key existed. Final fallback is a placeholder so the
//   facility name + queue deep link stay actionable even when both
//   sources are empty.
//
// Subject line:
//   Default `📊 Pipeline brief — YYYY-MM-DD`. When N replies > 0, the subject
//   is prefixed with `📬 N new replies | ` so the inbox preview signals warm
//   intent before Sonia opens the email.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Enrichment, type Lead } from '@prisma/client';
import { FilterOperatorEnum } from '@hubspot/api-client/lib/codegen/crm/objects/meetings/models/Filter.js';
import { z } from 'zod';
import { hs, hsRetry } from '../shared/hubspot.js';
import { sendEmail } from '../shared/gmail.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const MS_PER_MIN = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const LOOKBACK_MS = 24 * MS_PER_HOUR;

const HOT_LEADS_LIMIT = 5;
const AT_RISK_LIMIT = 3;
const CALL_LIST_LIMIT = 5;
// Pull a wider pool than the final 5 so we can filter on "lead has phone"
// without undershooting when the very top-scoring deals lack a phoneE164 in
// our DB (some deals come from HubSpot manual create, not the scrape path).
const CALL_LIST_CANDIDATE_POOL = 25;
const REPLY_FEED_LIMIT = 10;
const REPLY_SNIPPET_MAX = 240;
const HIRING_SPIKE_LIMIT = 10;
const MEETINGS_SEARCH_LIMIT = 1;
const DEAL_PROPERTIES = ['dealname', 'amount', 'hs_lastmodifieddate'];
const STALLED_RX = /^Stalled (\d+)d in stage$/;
// Sonia operates from the east coast — anchor the brief date to ET so a
// 6am cron run prints today's date, not "tomorrow" in UTC.
const BRIEF_TIMEZONE = 'America/New_York';
const SNIPPET_PLACEHOLDER = '_(snippet unavailable — open queue to view)_';

const STATE_TZ = new Map<string, 'ET' | 'CT' | 'MT' | 'PT' | 'AK' | 'HI'>([
  ['CT', 'ET'], ['DC', 'ET'], ['DE', 'ET'], ['FL', 'ET'], ['GA', 'ET'],
  ['IN', 'ET'], ['KY', 'ET'], ['MA', 'ET'], ['MD', 'ET'], ['ME', 'ET'],
  ['MI', 'ET'], ['NC', 'ET'], ['NH', 'ET'], ['NJ', 'ET'], ['NY', 'ET'],
  ['OH', 'ET'], ['PA', 'ET'], ['RI', 'ET'], ['SC', 'ET'], ['TN', 'ET'],
  ['VA', 'ET'], ['VT', 'ET'], ['WV', 'ET'],
  ['AL', 'CT'], ['AR', 'CT'], ['IA', 'CT'], ['IL', 'CT'], ['KS', 'CT'],
  ['LA', 'CT'], ['MN', 'CT'], ['MO', 'CT'], ['MS', 'CT'], ['ND', 'CT'],
  ['NE', 'CT'], ['OK', 'CT'], ['SD', 'CT'], ['TX', 'CT'], ['WI', 'CT'],
  ['AZ', 'MT'], ['CO', 'MT'], ['ID', 'MT'], ['MT', 'MT'], ['NM', 'MT'],
  ['UT', 'MT'], ['WY', 'MT'],
  ['CA', 'PT'], ['NV', 'PT'], ['OR', 'PT'], ['WA', 'PT'],
  ['AK', 'AK'], ['HI', 'HI'],
]);

const TZ_HINT: Record<string, string> = {
  ET: 'call morning (ET)',
  CT: 'call mid-morning (CT)',
  MT: 'call late morning (MT)',
  PT: 'call afternoon (PT)',
  AK: 'call afternoon (AKT)',
  HI: 'call afternoon (HST)',
};

const formatBriefDate = (d: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: BRIEF_TIMEZONE }).format(d);

const buildRelativeTime = (date: Date, now: Date): string => {
  const diff = Math.max(0, now.getTime() - date.getTime());
  if (diff < MS_PER_HOUR) {
    return `${Math.max(1, Math.round(diff / MS_PER_MIN))}m ago`;
  }
  if (diff < MS_PER_DAY) {
    return `${Math.max(1, Math.round(diff / MS_PER_HOUR))}h ago`;
  }
  return `${Math.max(1, Math.round(diff / MS_PER_DAY))}d ago`;
};

const callHint = (state: string): string =>
  TZ_HINT[STATE_TZ.get(state.toUpperCase()) ?? ''] ?? 'call during local business hours';

const parseStalledDays = (reasons: string[]): number | null => {
  for (const r of reasons) {
    const m = r.match(STALLED_RX);
    if (m !== null) return Number(m[1]);
  }
  return null;
};

const cleanSnippet = (raw: string): string => {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= REPLY_SNIPPET_MAX) return collapsed;
  return `${collapsed.slice(0, REPLY_SNIPPET_MAX - 1)}…`;
};

const formatPhoneForDisplay = (e164: string): string => {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (m === null) return e164;
  return `(${m[1]}) ${m[2]}-${m[3]}`;
};

interface ScoreFacts {
  hubspotDealId: string;
  score: number;
  expectedCommission: number;
  reasons: string[];
  scoredAt: Date;
}

const dedupeLatestScores = (
  rows: Array<{
    hubspotDealId: string;
    score: number;
    expectedCommission: number;
    reasons: string[];
    scoredAt: Date;
  }>,
): ScoreFacts[] => {
  // rows arrive sorted scoredAt DESC, so the first occurrence per dealId is
  // the latest — second-occurrence rows are silently dropped.
  const latest = new Map<string, ScoreFacts>();
  for (const r of rows) {
    if (latest.has(r.hubspotDealId)) continue;
    latest.set(r.hubspotDealId, {
      hubspotDealId: r.hubspotDealId,
      score: r.score,
      expectedCommission: r.expectedCommission,
      reasons: r.reasons,
      scoredAt: r.scoredAt,
    });
  }
  return [...latest.values()];
};

interface EnrichedDeal {
  dealId: string;
  dealName: string;
  lead: (Lead & { enrichment: Enrichment | null }) | null;
}

const enrichDeals = async (dealIds: string[]): Promise<Map<string, EnrichedDeal>> => {
  const out = new Map<string, EnrichedDeal>();
  if (dealIds.length === 0) return out;

  const results = await Promise.all(
    dealIds.map(async (id) => {
      try {
        const deal = await hsRetry(() =>
          hs.crm.deals.basicApi.getById(id, DEAL_PROPERTIES, undefined, ['companies']),
        );
        const companyId = deal.associations?.companies?.results[0]?.id ?? null;
        return { id, dealName: deal.properties.dealname ?? null, companyId };
      } catch {
        // HubSpot 404 / 5xx on a single deal must not nuke the whole brief —
        // fall back to bare dealId + no enrichment for this row.
        return { id, dealName: null, companyId: null };
      }
    }),
  );

  const companyIds = new Set<string>();
  for (const r of results) {
    if (r.companyId !== null) companyIds.add(r.companyId);
  }

  const leadByCompany = new Map<string, Lead & { enrichment: Enrichment | null }>();
  if (companyIds.size > 0) {
    const leads = await prisma.lead.findMany({
      where: { hubspotCompanyId: { in: [...companyIds] } },
      include: { enrichment: true },
    });
    for (const l of leads) {
      if (l.hubspotCompanyId !== null) leadByCompany.set(l.hubspotCompanyId, l);
    }
  }

  for (const r of results) {
    const lead = r.companyId === null ? null : (leadByCompany.get(r.companyId) ?? null);
    out.set(r.id, {
      dealId: r.id,
      dealName: r.dealName ?? '(unnamed deal)',
      lead,
    });
  }
  return out;
};

// `.partial()` so historical audit rows (written before Prompt 7.3 added
// `inboundSnippet`) still parse cleanly and fall through to the HubSpot
// fallback path.
const ReplyDraftMetaSchema = z.object({
  receivedAt: z.string(),
  inboundSnippet: z.string(),
}).partial();

const HiringSpikeMetaSchema = z.object({
  leadId: z.string(),
  facility: z.string(),
  city: z.string(),
  state: z.string(),
  roleTitles: z.array(z.string()).optional(),
});

interface HiringSpikeRow {
  dealId: string;
  facility: string;
  city: string;
  state: string;
  roles: string;
}

const buildHiringSpikeRows = async (since: Date): Promise<HiringSpikeRow[]> => {
  const rows = await prisma.auditLog.findMany({
    where: { action: 'intent.hiring-spike', createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: HIRING_SPIKE_LIMIT,
  });
  const out: HiringSpikeRow[] = [];
  for (const row of rows) {
    if (row.entityId === null) continue;
    const parsed = HiringSpikeMetaSchema.safeParse(row.meta);
    if (!parsed.success) continue;
    const roles = (parsed.data.roleTitles ?? []).slice(0, 2).join(', ');
    out.push({
      dealId: row.entityId,
      facility: parsed.data.facility,
      city: parsed.data.city,
      state: parsed.data.state,
      roles: roles === '' ? 'open roles' : roles,
    });
  }
  return out;
};

const renderHiringSpikes = (rows: HiringSpikeRow[]): string => {
  if (rows.length === 0) {
    return '## 🚨 Hiring spikes (24h)\n\n_None — no new hiring activity on open deals._';
  }
  const header = `## 🚨 Hiring spikes (24h) — ${rows.length}`;
  const items = rows.map((r) =>
    `- **${r.facility}** (${r.city}, ${r.state}) — now hiring: ${r.roles}`,
  ).join('\n');
  return `${header}\n\n${items}`;
};

const fetchInboundSnippet = async (
  hubspotInboundEmailId: string | null,
): Promise<string | null> => {
  if (hubspotInboundEmailId === null) return null;
  try {
    const obj = await hsRetry(() =>
      hs.crm.objects.emails.basicApi.getById(hubspotInboundEmailId, ['hs_email_text']),
    );
    const text = obj.properties.hs_email_text ?? null;
    return text === null || text.trim() === '' ? null : text;
  } catch {
    return null;
  }
};

interface ReplyRow {
  draftId: string;
  facility: string;
  city: string;
  state: string;
  ownerName: string | null;
  relativeTime: string;
  snippet: string;
}

type RepliedDraftRow = {
  id: string;
  createdAt: Date;
  hubspotInboundEmailId: string | null;
  lead: Lead & { enrichment: Enrichment | null };
};

const buildReplyRows = async (
  drafts: RepliedDraftRow[],
  now: Date,
): Promise<ReplyRow[]> => {
  if (drafts.length === 0) return [];

  // One audit-row scan extracts both receivedAt and the persisted inbound
  // snippet (Prompt 7.3). receivedAt falls back to draft.createdAt for the
  // P2002 resumed-write branch in replyWatcher, which doesn't re-audit on
  // the second pass. Snippet falls back to a HubSpot fetch (then to a
  // placeholder) for historical drafts written before Prompt 7.3.
  const auditRows = await prisma.auditLog.findMany({
    where: { action: 'reply.draft-created', entityId: { in: drafts.map((d) => d.id) } },
  });
  const receivedByDraft = new Map<string, Date>();
  const snippetByDraft = new Map<string, string>();
  for (const row of auditRows) {
    if (row.entityId === null) continue;
    const parsed = ReplyDraftMetaSchema.safeParse(row.meta);
    if (!parsed.success) continue;
    if (parsed.data.receivedAt !== undefined) {
      const ts = Date.parse(parsed.data.receivedAt);
      if (!Number.isNaN(ts)) receivedByDraft.set(row.entityId, new Date(ts));
    }
    const persisted = parsed.data.inboundSnippet;
    if (persisted !== undefined && persisted.trim() !== '') {
      snippetByDraft.set(row.entityId, persisted);
    }
  }

  // Sequential HubSpot GETs (≤ REPLY_FEED_LIMIT) so a thundering herd on the
  // inbound-emails endpoint can't trip the burst limit. The brief runs once
  // a day; latency is irrelevant. With Prompt 7.3 in place the steady-state
  // path skips HubSpot entirely — only historical drafts hit the fetch.
  const rows: ReplyRow[] = [];
  for (const d of drafts) {
    const persisted = snippetByDraft.get(d.id) ?? null;
    const rawSnippet = persisted ?? (await fetchInboundSnippet(d.hubspotInboundEmailId));
    const snippet = rawSnippet === null ? SNIPPET_PLACEHOLDER : cleanSnippet(rawSnippet);
    const received = receivedByDraft.get(d.id) ?? d.createdAt;
    rows.push({
      draftId: d.id,
      facility: d.lead.name,
      city: d.lead.city,
      state: d.lead.state,
      ownerName: d.lead.enrichment?.ownerName ?? null,
      relativeTime: buildRelativeTime(received, now),
      snippet,
    });
  }
  return rows;
};

const countMeetingsBookedSince = async (since: Date): Promise<number> => {
  try {
    const res = await hsRetry(() =>
      hs.crm.objects.meetings.searchApi.doSearch({
        filterGroups: [{
          filters: [{
            propertyName: 'hs_createdate',
            operator: FilterOperatorEnum.Gte,
            value: String(since.getTime()),
          }],
        }],
        properties: ['hs_createdate'],
        limit: MEETINGS_SEARCH_LIMIT,
      }),
    );
    return res.total ?? 0;
  } catch {
    return 0;
  }
};

const renderNewReplies = (rows: ReplyRow[], publicUrl: string): string => {
  if (rows.length === 0) {
    return '## 📬 New replies (24h)\n\n_None — quiet day on inbound._';
  }
  const header = `## 📬 New replies (24h) — ${rows.length}`;
  const items = rows.map((r) => {
    const owner = r.ownerName ?? '—';
    const link = `${publicUrl}/queue#draft-${r.draftId}`;
    return [
      `- **${r.facility}** (${r.city}, ${r.state}) · ${owner} · ${r.relativeTime}`,
      `  > ${r.snippet}`,
      `  [→ Review in queue](${link})`,
    ].join('\n');
  }).join('\n');
  return `${header}\n\n${items}`;
};

const renderHotLeads = (
  rows: ScoreFacts[],
  deals: Map<string, EnrichedDeal>,
): string => {
  const header = '## 🔥 Top 5 hot leads (sorted by score × commission)';
  if (rows.length === 0) return `${header}\n\n_No scored deals in the last 24h._`;
  const items = rows.map((s, i) => {
    const enriched = deals.get(s.hubspotDealId);
    const dealName = enriched?.dealName ?? '(unnamed deal)';
    const location = enriched?.lead
      ? ` (${enriched.lead.city}, ${enriched.lead.state})`
      : '';
    const value = s.score * s.expectedCommission;
    return `${i + 1}. **${dealName}**${location} — score ${s.score} × $${s.expectedCommission} = $${value}`;
  }).join('\n');
  return `${header}\n\n${items}`;
};

const renderAtRisk = (
  rows: Array<{ score: ScoreFacts; stalledDays: number }>,
  deals: Map<string, EnrichedDeal>,
): string => {
  const header = '## ⚠️ Top 3 deals at risk';
  if (rows.length === 0) return `${header}\n\n_No stalled deals — pipeline is moving._`;
  const items = rows.map((r, i) => {
    const enriched = deals.get(r.score.hubspotDealId);
    const dealName = enriched?.dealName ?? '(unnamed deal)';
    const location = enriched?.lead
      ? ` (${enriched.lead.city}, ${enriched.lead.state})`
      : '';
    return `${i + 1}. **${dealName}**${location} — stalled ${r.stalledDays}d in stage · score ${r.score.score}`;
  }).join('\n');
  return `${header}\n\n${items}`;
};

interface CallListRow {
  dealName: string;
  phone: string;
  city: string;
  state: string;
  score: number;
  hint: string;
}

const renderCallList = (rows: CallListRow[]): string => {
  const header = '## 📞 Suggested call list (tomorrow)';
  if (rows.length === 0) {
    return `${header}\n\n_No leads with phone numbers in the top pool._`;
  }
  const items = rows.map((r, i) =>
    `${i + 1}. **${r.dealName}** (${r.city}, ${r.state}) — ${r.phone} · ${r.hint} · score ${r.score}`,
  ).join('\n');
  return `${header}\n\n${items}`;
};

const buildCallList = (
  candidates: ScoreFacts[],
  deals: Map<string, EnrichedDeal>,
): CallListRow[] => {
  const rows: CallListRow[] = [];
  for (const s of candidates) {
    if (rows.length >= CALL_LIST_LIMIT) break;
    const enriched = deals.get(s.hubspotDealId);
    if (enriched === undefined || enriched.lead === null) continue;
    const phoneE164 = enriched.lead.phoneE164;
    if (phoneE164 === null) continue;
    rows.push({
      dealName: enriched.dealName,
      phone: formatPhoneForDisplay(phoneE164),
      city: enriched.lead.city,
      state: enriched.lead.state,
      score: s.score,
      hint: callHint(enriched.lead.state),
    });
  }
  return rows;
};

export const sendDailyBrief = async (): Promise<void> => {
  const recipient = process.env.BRIEF_RECIPIENT ?? '';
  if (recipient === '') throw new Error('BRIEF_RECIPIENT is not set');
  const publicUrl = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');

  const now = new Date();
  const date = formatBriefDate(now);
  const cutoff = new Date(now.getTime() - LOOKBACK_MS);

  const [
    scoreRows,
    repliedDrafts,
    pendingCount,
    sentCount,
    repliesCount,
    meetingsCount,
  ] = await Promise.all([
    prisma.score.findMany({
      where: { scoredAt: { gte: cutoff } },
      orderBy: { scoredAt: 'desc' },
      select: {
        hubspotDealId: true,
        score: true,
        expectedCommission: true,
        reasons: true,
        scoredAt: true,
      },
    }),
    prisma.draft.findMany({
      where: { kind: 'replied', createdAt: { gte: cutoff } },
      orderBy: { createdAt: 'desc' },
      take: REPLY_FEED_LIMIT,
      include: { lead: { include: { enrichment: true } } },
    }),
    prisma.draft.count({ where: { status: 'pending' } }),
    prisma.draft.count({
      where: {
        status: { in: ['sent', 'auto-sent'] },
        sentAt: { gte: cutoff },
      },
    }),
    prisma.draft.count({
      where: { kind: 'replied', createdAt: { gte: cutoff } },
    }),
    countMeetingsBookedSince(cutoff),
  ]);

  const latestScores = dedupeLatestScores(scoreRows);

  // Hot leads ranked by score × commission descending.
  const hotByValue = [...latestScores].sort(
    (a, b) => b.score * b.expectedCommission - a.score * a.expectedCommission,
  );
  const hotTop = hotByValue.slice(0, HOT_LEADS_LIMIT);

  // At-risk: any reason matches "Stalled Nd in stage". Sort by stage age DESC.
  const atRiskCandidates = latestScores
    .map((s) => ({ score: s, stalledDays: parseStalledDays(s.reasons) }))
    .filter((x): x is { score: ScoreFacts; stalledDays: number } => x.stalledDays !== null)
    .sort((a, b) => b.stalledDays - a.stalledDays);
  const atRiskTop = atRiskCandidates.slice(0, AT_RISK_LIMIT);

  const callCandidates = hotByValue.slice(0, CALL_LIST_CANDIDATE_POOL);

  // Single batched HubSpot fetch for every deal we'll surface.
  const allDealIds = new Set<string>();
  for (const s of hotTop) allDealIds.add(s.hubspotDealId);
  for (const r of atRiskTop) allDealIds.add(r.score.hubspotDealId);
  for (const s of callCandidates) allDealIds.add(s.hubspotDealId);
  const enriched = await enrichDeals([...allDealIds]);

  const callList = buildCallList(callCandidates, enriched);
  const replyRows = await buildReplyRows(repliedDrafts, now);
  const hiringSpikeRows = await buildHiringSpikeRows(cutoff);

  const body = [
    `# 📊 Pipeline brief — ${date}`,
    '',
    renderNewReplies(replyRows, publicUrl),
    '',
    renderHiringSpikes(hiringSpikeRows),
    '',
    renderHotLeads(hotTop, enriched),
    '',
    renderAtRisk(atRiskTop, enriched),
    '',
    renderCallList(callList),
    '',
    `## 📥 Queue: ${pendingCount} pending`,
    `## 📈 Yesterday: sent ${sentCount} | replies ${repliesCount} | meetings ${meetingsCount}`,
    '',
  ].join('\n');

  const baseSubject = `📊 Pipeline brief — ${date}`;
  const subject = replyRows.length === 0
    ? baseSubject
    : `📬 ${replyRows.length} new replies | ${baseSubject}`;

  await sendEmail({ to: recipient, subject, body });

  await prisma.auditLog.create({
    data: {
      action: 'dailyBrief.sent',
      entity: 'dailyBrief',
      meta: {
        date,
        recipient,
        replyCount: replyRows.length,
        hiringSpikeCount: hiringSpikeRows.length,
        hotCount: hotTop.length,
        atRiskCount: atRiskTop.length,
        callListCount: callList.length,
        pendingCount,
        sentCount,
        repliesCount,
        meetingsCount,
      },
    },
  });
};
