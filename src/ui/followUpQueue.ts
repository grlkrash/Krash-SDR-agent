import express from 'express';
import { queueAuth } from '../middleware/queueAuth.js';
import { buildFollowUpRows, completeFollowUpTask } from '../outreach/followUpTask.js';

export const followUpQueueRouter = express.Router();

const FollowUpIdSchema = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });

const readFollowUpId = (req: express.Request): string | null => {
  const raw = req.params.id;
  if (typeof raw !== 'string' || !FollowUpIdSchema.test(raw)) return null;
  return raw;
};

const formatDueEt = (d: Date): string => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
  return `${parts} ET`;
};

const pageStyles = `
  body { font-family: system-ui, sans-serif; margin: 24px; max-width: 1024px; color: #111; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .meta { color: #64748b; font-size: 14px; margin-bottom: 16px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 20px; }
  .toolbar a { color: #2563eb; text-decoration: none; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { border: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; }
  .btn { padding: 6px 10px; border-radius: 6px; border: none; font-weight: 600; cursor: pointer; font-size: 12px; margin: 2px 0; }
  .btn-done { background: #16a34a; color: #fff; }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: #dbeafe; color: #1e40af; }
  .tag-overdue { background: #fee2e2; color: #991b1b; }
  .tag-context { background: #f3e8ff; color: #6b21a8; }
  .empty { color: #64748b; padding: 24px 0; }
  .disclaimer { background: #eff6ff; border: 1px solid #93c5fd; padding: 10px; border-radius: 8px;
    font-size: 13px; margin-bottom: 16px; }
`;

const renderRow = (r: Awaited<ReturnType<typeof buildFollowUpRows>>[number]): string => {
  const owner = r.ownerName ?? '—';
  const prepBrief = ` · <a href="/prep-brief/lead/${encodeURIComponent(r.leadId)}" target="_blank">Prep brief</a>`;
  const overdue = r.dueAt.getTime() <= Date.now();
  const dueTag = overdue
    ? `<span class="tag tag-overdue">due now</span>`
    : `<span class="tag">due ${escapeHtml(formatDueEt(r.dueAt))}</span>`;
  const notes = r.notes !== null
    ? `<br/><span class="meta">${escapeHtml(r.notes)}</span>`
    : '';
  const contextLabel = r.context.replace(/:/g, ' · ');
  return `<tr>
    <td><strong>${escapeHtml(r.facility)}</strong><br/>
      <span class="meta">${escapeHtml(r.city)}, ${escapeHtml(r.state)}${prepBrief}</span></td>
    <td><a href="tel:${escapeHtml(r.phoneE164)}">${escapeHtml(r.phone)}</a><br/>
      <span class="meta">${escapeHtml(r.hint)}</span></td>
    <td>${escapeHtml(owner)}</td>
    <td>${dueTag}${notes}</td>
    <td><span class="tag tag-context">${escapeHtml(contextLabel)}</span></td>
    <td>
      <form method="POST" action="/follow-ups/complete/${encodeURIComponent(r.followUpId)}">
        <button type="submit" class="btn btn-done" title="Mark follow-up done — closes HubSpot task">✓ Complete</button>
      </form>
    </td>
  </tr>`;
};

followUpQueueRouter.get('/follow-ups', queueAuth, async (_req, res) => {
  const rows = await buildFollowUpRows({ limit: 100 });
  const tableBody = rows.length === 0
    ? `<tr><td colspan="6" class="empty">No scheduled follow-ups — you're caught up.</td></tr>`
    : rows.map(renderRow).join('');

  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <title>Follow-ups to call</title>
  <style>${pageStyles}</style>
</head><body>
  <h1>Follow-ups to call</h1>
  <p class="meta">Customer-requested callbacks from outbound dispositions and demo booking · HubSpot tasks mirror this queue</p>
  <div class="disclaimer">Set a <strong>follow-up date</strong> when dispositioning calls on <a href="/outbound">/outbound</a> or <a href="/cold-call">/cold-call</a>. Tasks appear here sorted by due date. <strong>Complete</strong> closes the task in HubSpot too.</div>
  <div class="toolbar">
    <a href="/queue">← Draft queue</a>
    <a href="/outbound">Outbound cadence</a>
  </div>
  <table>
    <thead><tr>
      <th>Facility</th><th>Phone</th><th>Owner</th><th>Due</th><th>Context</th><th>Actions</th>
    </tr></thead>
    <tbody>${tableBody}</tbody>
  </table>
</body></html>`);
});

followUpQueueRouter.post('/follow-ups/complete/:id', queueAuth, async (req, res) => {
  const id = readFollowUpId(req);
  if (id === null) {
    res.status(400).json({ error: 'invalid follow-up id' });
    return;
  }
  try {
    await completeFollowUpTask(id);
    const returnTo = typeof req.body.returnTo === 'string' && req.body.returnTo.startsWith('/')
      ? req.body.returnTo
      : '/follow-ups';
    res.redirect(303, returnTo);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).type('html').send(`<p>${escapeHtml(msg)}</p><a href="/follow-ups">Back</a>`);
  }
});
