import type { EnrichedDeal, ScoreFacts } from './deals.js';
import { callHint, formatPhoneForDisplay } from './shared.js';

export const CALL_LIST_LIMIT = 5;

export interface CallListRow {
  dealName: string;
  phone: string;
  city: string;
  state: string;
  score: number;
  hint: string;
}

export const buildCallList = (
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

export const renderCallList = (rows: CallListRow[]): string => {
  const header = '## 📞 Suggested call list (tomorrow)';
  if (rows.length === 0) {
    return `${header}\n\n_No leads with phone numbers in the top pool._`;
  }
  const items = rows.map((r, i) =>
    `${i + 1}. **${r.dealName}** (${r.city}, ${r.state}) — ${r.phone} · ${r.hint} · score ${r.score}`,
  ).join('\n');
  return `${header}\n\n${items}`;
};
