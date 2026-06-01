import type { ColdCallRow } from '../coldCallFlag.js';
import { COLD_CALL_MAX_TOUCHES } from '../../shared/coldCallTouches.js';

export const COLD_CALLS_BRIEF_LIMIT = 8;

export const renderColdCallsToMake = (
  rows: ColdCallRow[],
  publicUrl: string,
  openCount: number,
): string => {
  const queueUrl = `${publicUrl}/cold-call`;
  const header = '## 📞 Cold calls to make (3-touch cadence)';
  if (openCount === 0) {
    return `${header}\n\n_None — no cold sequences awaiting a call._`;
  }
  const backlogNote = openCount > rows.length
    ? `\n\n_${openCount} total open in [cold call queue](${queueUrl}); showing ${rows.length}._`
    : `\n\n_[Open cold call queue](${queueUrl}) (${openCount} pending) — lead with the free profile._`;
  if (rows.length === 0) {
    return `${header}${backlogNote}`;
  }
  const items = rows.map((r, i) => {
    const owner = r.ownerName ?? '—';
    const touch = r.nextTouchNumber === null
      ? ''
      : ` · call ${String(r.nextTouchNumber)}/${String(COLD_CALL_MAX_TOUCHES)}`;
    return `${i + 1}. **${r.facility}** (${r.city}, ${r.state}) — ${r.phone} · ${owner}${touch} · ${r.hint}`;
  }).join('\n');
  return `${header}${backlogNote}\n\n${items}`;
};
