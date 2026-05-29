import type { RenewalCallRow } from '../renewalCallFlag.js';

export const RENEWALS_CALL_BRIEF_LIMIT = 8;

export const renderRenewalsToCall = (
  rows: RenewalCallRow[],
  publicUrl: string,
  openCount: number,
): string => {
  const queueUrl = `${publicUrl}/renewals-call`;
  const header = '## 📞 Renewals to call (7-day touch window)';
  if (openCount === 0) {
    return `${header}\n\n_None — no open renewal call sequences._`;
  }
  const backlogNote = openCount > rows.length
    ? `\n\n_${openCount} total open in [renewals call queue](${queueUrl}); showing ${rows.length}._`
    : `\n\n_[Open renewals call queue](${queueUrl}) (${openCount} pending)_`;
  if (rows.length === 0) {
    return `${header}${backlogNote}`;
  }
  const items = rows.map((r, i) => {
    const owner = r.ownerName ?? '—';
    const touch = r.nextTouchNumber === null
      ? `${String(r.touchesDone)}/${String(5)} touches logged`
      : `Touch ${String(r.nextTouchNumber)}/5 · ${r.hint}`;
    return `${i + 1}. **${r.facility}** (${r.city}, ${r.state}) — ${r.phone} · ${owner} · ${touch}`;
  }).join('\n');
  return `${header}${backlogNote}\n\n${items}`;
};
