import type { EnrichedDeal, ScoreFacts } from './deals.js';

const STALLED_RX = /^Stalled (\d+)d in stage$/;

export const parseStalledDays = (reasons: string[]): number | null => {
  for (const r of reasons) {
    const m = r.match(STALLED_RX);
    if (m !== null) return Number(m[1]);
  }
  return null;
};

export const renderHotLeads = (
  rows: ScoreFacts[],
  deals: Map<string, EnrichedDeal>,
): string => {
  const header = '## 🔥 Top 5 hot leads (sorted by score × commission)';
  if (rows.length === 0) return `${header}\n\n_No hot leads in the last 24h._`;
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

export const renderAtRisk = (
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
