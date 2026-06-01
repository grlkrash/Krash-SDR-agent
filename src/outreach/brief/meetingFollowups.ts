import type { MeetingFollowupRow } from '../meetingFollowup.js';
import { formatBriefDate } from './shared.js';

export const MEETING_FOLLOWUPS_BRIEF_LIMIT = 8;

export const renderMeetingFollowups = (
  rows: MeetingFollowupRow[],
  openCount: number,
): string => {
  const header = '## 🗓️ Meetings to follow up (recently passed)';
  if (openCount === 0) {
    return `${header}\n\n_None — no passed meetings awaiting a recap or reschedule._`;
  }
  const note = '\n\n_Send a recap if it was held, or a reschedule if it was a no-show._';
  const backlog = openCount > rows.length
    ? `\n\n_${openCount} total; showing ${rows.length}._`
    : '';
  if (rows.length === 0) {
    return `${header}${note}${backlog}`;
  }
  const items = rows.map((r, i) => {
    const owner = r.ownerName ?? '—';
    const phone = r.phone ?? 'no phone';
    return `${i + 1}. **${r.facility}** (${r.city}, ${r.state}) — met ${formatBriefDate(r.startAt)} · ${phone} · ${owner} · ${r.hint}`;
  }).join('\n');
  return `${header}${note}${backlog}\n\n${items}`;
};
