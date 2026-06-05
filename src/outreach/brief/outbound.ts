import type { OutboundRow } from '../outboundSequence.js';
import { OUTBOUND_STEP_LABELS } from '../../shared/outboundSteps.js';

export const OUTBOUND_BRIEF_LIMIT = 8;

export const renderOutboundCadence = (
  rows: OutboundRow[],
  publicUrl: string,
  openCount: number,
): string => {
  const queueUrl = `${publicUrl}/outbound`;
  const header = '## 📞 Outbound cadence (call-first)';
  if (openCount === 0) {
    return `${header}\n\n_None — start outreach from [outbound queue](${queueUrl})._`;
  }
  const backlogNote = openCount > rows.length
    ? `\n\n_${openCount} active in [outbound queue](${queueUrl}); showing ${rows.length}._`
    : `\n\n_[Open outbound queue](${queueUrl}) (${openCount} active) — call 1 → VM → email → demo-book call._`;
  if (rows.length === 0) {
    return `${header}${backlogNote}`;
  }
  const items = rows.map((r, i) => {
    const owner = r.ownerName ?? '—';
    const step = OUTBOUND_STEP_LABELS[r.currentStep];
    return `${i + 1}. **${r.facility}** (${r.city}, ${r.state}) — ${r.phone} · ${owner} · _${step}_ · ${r.hint}`;
  }).join('\n');
  return `${header}${backlogNote}\n\n${items}`;
};
