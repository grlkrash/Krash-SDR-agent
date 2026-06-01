import type { ReactivationCallRow } from '../reactivationCallFlag.js';

export const REACTIVATIONS_CALL_BRIEF_LIMIT = 8;

export const renderReactivationsToCall = (
  rows: ReactivationCallRow[],
  openCount: number,
): string => {
  const header = '## 📞 Reactivations to call (14-day window)';
  if (openCount === 0) {
    return `${header}\n\n_None — no reactivation emails awaiting a call._`;
  }
  // No web page for this lane — the HubSpot task is where the call gets worked.
  const backlogNote = openCount > rows.length
    ? `\n\n_${openCount} total flagged (work the HubSpot tasks); showing ${rows.length}._`
    : `\n\n_${openCount} flagged — see HubSpot tasks._`;
  if (rows.length === 0) {
    return `${header}${backlogNote}`;
  }
  const items = rows.map((r, i) => {
    const owner = r.ownerName ?? '—';
    return `${i + 1}. **${r.facility}** (${r.city}, ${r.state}) — ${r.phone} · ${owner} · ${r.hint}`;
  }).join('\n');
  return `${header}${backlogNote}\n\n${items}`;
};
