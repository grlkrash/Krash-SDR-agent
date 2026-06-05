import express from 'express';
import { queueAuth } from '../middleware/queueAuth.js';
import { COLD_CALL_MAX_TOUCHES } from '../shared/coldCallTouches.js';
import {
  buildColdCallRows,
  completeColdCall,
  logColdCallTouch,
} from '../outreach/coldCallFlag.js';

export const coldCallRouter = express.Router();

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });

const DraftIdSchema = /^[a-z0-9]+$/;

const readId = (req: express.Request): string | null => {
  const raw = req.params.id;
  if (typeof raw !== 'string' || !DraftIdSchema.test(raw)) return null;
  return raw;
};

const readTouchNumber = (raw: unknown): number => {
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= COLD_CALL_MAX_TOUCHES) return n;
  return 1;
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
  .btn-connected { background: #16a34a; color: #fff; }
  .btn-no-answer { background: #64748b; color: #fff; }
  .btn-done { background: #1d4ed8; color: #fff; }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: #dbeafe; color: #1e40af; }
  .tag-overdue { background: #fee2e2; color: #991b1b; }
  .empty { color: #64748b; padding: 24px 0; }
  .disclaimer { background: #eff6ff; border: 1px solid #93c5fd; padding: 10px; border-radius: 8px;
    font-size: 13px; margin-bottom: 16px; }
`;

const renderRow = (r: Awaited<ReturnType<typeof buildColdCallRows>>[number]): string => {
  const owner = r.ownerName ?? '—';
  const prepBrief = ` · <a href="/prep-brief/lead/${encodeURIComponent(r.leadId)}" target="_blank">Prep brief</a>`;
  const touch = r.nextTouchNumber === null
    ? `${String(r.touchesDone)}/${String(COLD_CALL_MAX_TOUCHES)} logged`
    : `Touch ${String(r.nextTouchNumber)}/${String(COLD_CALL_MAX_TOUCHES)}`;
  const expired = r.windowEndAt.getTime() <= Date.now();
  const windowTag = expired
    ? `<span class="tag tag-overdue">window closing</span>`
    : `<span class="tag">window to ${escapeHtml(r.windowEndAt.toISOString().slice(0, 10))}</span>`;
  const touchNumber = String(r.nextTouchNumber ?? 1);
  return `<tr>
    <td><strong>${escapeHtml(r.facility)}</strong><br/>
      <span class="meta">${escapeHtml(r.city)}, ${escapeHtml(r.state)}${prepBrief}</span></td>
    <td><a href="tel:${escapeHtml(r.phoneE164)}">${escapeHtml(r.phone)}</a><br/>
      <span class="meta">${escapeHtml(r.hint)}</span></td>
    <td>${escapeHtml(owner)}</td>
    <td>Email sent ${escapeHtml(r.sentAt.toISOString().slice(0, 10))}<br/>${windowTag}</td>
    <td>${escapeHtml(touch)}</td>
    <td>
      <form method="POST" action="/cold-call/touch/${encodeURIComponent(r.draftId)}" style="display:inline">
        <input type="hidden" name="outcome" value="connected" />
        <input type="hidden" name="touchNumber" value="${escapeHtml(touchNumber)}" />
        <button type="submit" class="btn btn-connected" title="Log connected call — closes sequence">✓ Connected</button>
      </form>
      <form method="POST" action="/cold-call/touch/${encodeURIComponent(r.draftId)}" style="display:inline">
        <input type="hidden" name="outcome" value="no-answer" />
        <input type="hidden" name="touchNumber" value="${escapeHtml(touchNumber)}" />
        <button type="submit" class="btn btn-no-answer">No answer</button>
      </form>
      <form method="POST" action="/cold-call/complete/${encodeURIComponent(r.draftId)}" style="display:inline"
        onsubmit="return confirm('Close this cold-call sequence without logging another touch?')">
        <button type="submit" class="btn btn-done">Done</button>
      </form>
    </td>
  </tr>`;
};

coldCallRouter.get('/cold-call', queueAuth, async (_req, res) => {
  const rows = await buildColdCallRows({ limit: 100 });
  const tableBody = rows.length === 0
    ? `<tr><td colspan="6" class="empty">No open cold calls — you're caught up.</td></tr>`
    : rows.map(renderRow).join('');

  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <title>Cold calls to make</title>
  <style>${pageStyles}</style>
</head><body>
  <h1>Cold calls to make</h1>
  <p class="meta">3 touches on business days 2, 5, 9 after the cold email sends · HubSpot tasks mirror this queue</p>
  <div class="disclaimer">Lead with the free Sobriety Select profile; keep paid tiers for the booked call. <strong>Connected</strong> closes the sequence and logs a HubSpot call. <strong>No answer</strong> logs the attempt and keeps the cadence going. <strong>Done</strong> closes the sequence.</div>
  <div class="toolbar">
    <a href="/queue">← Draft queue</a>
  </div>
  <table>
    <thead><tr>
      <th>Facility</th><th>Phone</th><th>Owner</th><th>Timeline</th><th>Next touch</th><th>Actions</th>
    </tr></thead>
    <tbody>${tableBody}</tbody>
  </table>
</body></html>`);
});

coldCallRouter.post('/cold-call/touch/:id', queueAuth, async (req, res) => {
  const id = readId(req);
  if (id === null) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const outcome = req.body.outcome === 'connected' ? 'connected' : 'no-answer';
  const touchNumber = readTouchNumber(req.body.touchNumber);
  await logColdCallTouch({ draftId: id, touchNumber, outcome });
  res.redirect(303, '/cold-call');
});

coldCallRouter.post('/cold-call/complete/:id', queueAuth, async (req, res) => {
  const id = readId(req);
  if (id === null) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  await completeColdCall(id, 'operator-completed');
  res.redirect(303, '/cold-call');
});
