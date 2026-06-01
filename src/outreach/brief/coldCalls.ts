import type { ColdCallRow } from '../coldCallFlag.js';

export const COLD_CALLS_BRIEF_LIMIT = 8;

export const renderColdCallsToMake = (
  rows: ColdCallRow[],
  openCount: number,
): string => {
  const header = '## 📞 Cold calls to make (10-day window)';
  if (openCount === 0) {
    return `${header}\n\n_None — no cold emails awaiting a paired call._`;
  }
  // No web page for this lane — the HubSpot task is where the call gets worked.
  const backlogNote = openCount > rows.length
    ? `\n\n_${openCount} total flagged (work the HubSpot tasks); showing ${rows.length}._`
    : `\n\n_${openCount} flagged — see HubSpot tasks. Lead with the free profile._`;
  if (rows.length === 0) {
    return `${header}${backlogNote}`;
  }
  const items = rows.map((r, i) => {
    const owner = r.ownerName ?? '—';
    return `${i + 1}. **${r.facility}** (${r.city}, ${r.state}) — ${r.phone} · ${owner} · ${r.hint}`;
  }).join('\n');
  return `${header}${backlogNote}\n\n${items}`;
};
