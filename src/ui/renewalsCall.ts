import express from 'express';
import { queueAuth } from '../middleware/queueAuth.js';
import { RENEWAL_MAX_TOUCHES } from '../shared/renewalCallTouches.js';
import {
  buildRenewalCallRows,
  completeRenewalCall,
  logRenewalCallTouch,
} from '../outreach/renewalCallFlag.js';

export const renewalsCallRouter = express.Router();

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
  .btn-confirmed { background: #1d4ed8; color: #fff; }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: #dbeafe; color: #1e40af; }
  .tag-overdue { background: #fee2e2; color: #991b1b; }
  .empty { color: #64748b; padding: 24px 0; }
  .disclaimer { background: #eff6ff; border: 1px solid #93c5fd; padding: 10px; border-radius: 8px;
    font-size: 13px; margin-bottom: 16px; }
`;

const renderRow = (r: Awaited<ReturnType<typeof buildRenewalCallRows>>[number]): string => {
  const owner = r.ownerName ?? '—';
  const prepBrief = r.hubspotCompanyId === null
    ? ''
    : ` · <a href="/prep-brief/lookup?companyId=${encodeURIComponent(r.hubspotCompanyId)}" target="_blank">Prep brief</a>`;
  const nextTouch = r.nextTouchNumber === null
    ? `${String(r.touchesDone)}/${String(RENEWAL_MAX_TOUCHES)} logged`
    : `Touch ${String(r.nextTouchNumber)}/${String(RENEWAL_MAX_TOUCHES)}`;
  const dueLabel = r.nextTouchDueAt === null
    ? ''
    : r.nextTouchDueAt.getTime() <= Date.now()
      ? `<span class="tag tag-overdue">due now</span>`
      : `<span class="tag">due ${escapeHtml(r.nextTouchDueAt.toISOString().slice(0, 10))}</span>`;
  return `<tr>
    <td><strong>${escapeHtml(r.facility)}</strong><br/>
      <span class="meta">${escapeHtml(r.city)}, ${escapeHtml(r.state)}${prepBrief}</span></td>
    <td><a href="tel:${escapeHtml(r.phoneE164)}">${escapeHtml(r.phone)}</a><br/>
      <span class="meta">${escapeHtml(r.hint)}</span></td>
    <td>${escapeHtml(owner)}</td>
    <td>Email sent ${escapeHtml(r.sentAt.toISOString().slice(0, 10))}<br/>
      Window ends ${escapeHtml(r.windowEndAt.toISOString().slice(0, 10))}</td>
    <td>${escapeHtml(nextTouch)} ${dueLabel}</td>
    <td>
      <form method="POST" action="/renewals-call/touch/${encodeURIComponent(r.draftId)}" style="display:inline">
        <input type="hidden" name="outcome" value="connected" />
        <button type="submit" class="btn btn-connected" title="Log connected call — closes sequence">✓ Connected</button>
      </form>
      <form method="POST" action="/renewals-call/touch/${encodeURIComponent(r.draftId)}" style="display:inline">
        <input type="hidden" name="outcome" value="no-answer" />
        <button type="submit" class="btn btn-no-answer">No answer</button>
      </form>
      <form method="POST" action="/renewals-call/complete/${encodeURIComponent(r.draftId)}" style="display:inline"
        onsubmit="return confirm('Mark renewal confirmed without logging another touch?')">
        <button type="submit" class="btn btn-confirmed">Renewal confirmed</button>
      </form>
    </td>
  </tr>`;
};

renewalsCallRouter.get('/renewals-call', queueAuth, async (_req, res) => {
  const rows = await buildRenewalCallRows({ limit: 100 });
  const tableBody = rows.length === 0
    ? `<tr><td colspan="6" class="empty">No open renewal calls — you're caught up.</td></tr>`
    : rows.map(renderRow).join('');

  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <title>Renewals to call</title>
  <style>${pageStyles}</style>
</head><body>
  <h1>Renewals to call</h1>
  <p class="meta">5 touches on business days 3–7 after the renewal email sends · HubSpot tasks mirror this queue</p>
  <div class="disclaimer">Live renewal calls only — no AI voicemail for renewals. Log each attempt; <strong>Connected</strong> or <strong>Renewal confirmed</strong> closes the sequence.</div>
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

renewalsCallRouter.post('/renewals-call/touch/:id', queueAuth, async (req, res) => {
  const id = readId(req);
  if (id === null) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const outcome = req.body.outcome === 'connected' ? 'connected' : 'no-answer';
  await logRenewalCallTouch({ draftId: id, outcome });
  res.redirect(303, '/renewals-call');
});

renewalsCallRouter.post('/renewals-call/complete/:id', queueAuth, async (req, res) => {
  const id = readId(req);
  if (id === null) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  await completeRenewalCall(id, 'operator-confirmed');
  res.redirect(303, '/renewals-call');
});
