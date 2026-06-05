import express from 'express';
import { z } from 'zod';
import { queueAuth } from '../middleware/queueAuth.js';
import { bookDiscoveryMeeting } from '../outreach/bookDiscoveryMeeting.js';
import {
  buildOutboundRows,
  buildOutboundStartCandidates,
  logOutboundColdEmailSent,
  logOutboundTouch,
  startOutboundSequence,
} from '../outreach/outboundSequence.js';
import { getBookingLink } from '../shared/bookingLink.js';
import { hasCalendarScope } from '../shared/googleCalendar.js';
import {
  loadDealStageOptions,
  updateDealStage,
  type DealStageOption,
} from '../shared/hubspotDealStages.js';
import { ensureDealForLead } from '../shared/ensureHubspotDeal.js';
import {
  OUTBOUND_STEP_HINTS,
  OUTBOUND_STEP_LABELS,
  type OutboundStep,
} from '../shared/outboundSteps.js';

export const outboundRouter = express.Router();

const LeadIdSchema = /^[a-z0-9]+$/;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });

const readLeadId = (req: express.Request): string | null => {
  const raw = req.params.leadId ?? req.params.id;
  if (typeof raw !== 'string' || !LeadIdSchema.test(raw)) return null;
  return raw;
};

const pageStyles = `
  body { font-family: system-ui, sans-serif; margin: 24px; max-width: 1100px; color: #111; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  h2 { font-size: 16px; margin: 24px 0 8px; }
  .meta { color: #64748b; font-size: 14px; margin-bottom: 16px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 20px; }
  .toolbar a { color: #2563eb; text-decoration: none; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 24px; }
  th, td { border: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; }
  .btn { padding: 6px 10px; border-radius: 6px; border: none; font-weight: 600; cursor: pointer; font-size: 12px; margin: 2px 4px 2px 0; }
  .btn-primary { background: #2563eb; color: #fff; }
  .btn-connected { background: #16a34a; color: #fff; }
  .btn-muted { background: #64748b; color: #fff; }
  .btn-start { background: #0f766e; color: #fff; }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: #dbeafe; color: #1e40af; display: inline-block; }
  .tag-step { background: #fef3c7; color: #92400e; }
  .empty { color: #64748b; padding: 12px 0; }
  .disclaimer { background: #eff6ff; border: 1px solid #93c5fd; padding: 10px; border-radius: 8px;
    font-size: 13px; margin-bottom: 16px; line-height: 1.45; }
  .notes { width: 100%; min-height: 52px; font-size: 13px; margin: 6px 0; padding: 6px; }
  .book-form { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; margin-top: 8px; }
  .book-form label { display: block; font-size: 12px; color: #475569; margin: 6px 0 2px; }
  .book-form input, .book-form select { font-size: 13px; padding: 4px 6px; }
  .flash { background: #ecfdf5; border: 1px solid #6ee7b7; padding: 10px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
  .flash-warn { background: #fffbeb; border: 1px solid #fcd34d; }
  .phone-links a { display: inline-block; margin-right: 8px; font-weight: 600; }
  .deal-stage-form select { font-size: 12px; max-width: 220px; }
`;

const renderPhoneCell = (r: {
  phone: string;
  phoneE164: string;
  hubspotCallUrl: string | null;
}): string => {
  const hsLink = r.hubspotCallUrl !== null
    ? `<a href="${escapeHtml(r.hubspotCallUrl)}" target="_blank" rel="noopener">Call in HubSpot</a>`
    : '';
  return `<div class="phone-links">
    ${hsLink}
    <a href="tel:${escapeHtml(r.phoneE164)}">Dial ${escapeHtml(r.phone)}</a>
  </div>
  <span class="meta">${hsLink !== '' ? 'Open HubSpot record → click the phone icon to call & log.' : 'Sync lead to HubSpot for click-to-call.'}</span>`;
};

const renderBookDemoForm = (
  r: Awaited<ReturnType<typeof buildOutboundRows>>[number],
  calendarOk: boolean,
): string => {
  const bookUrl = getBookingLink();
  const emailDefault = escapeHtml(r.ownerEmail ?? '');
  const calHint = calendarOk
    ? 'Sends Google Calendar invite with Meet to client email + logs meeting in HubSpot.'
    : 'Calendar scope missing — run <code>npx tsx src/scripts/gmailAuth.ts</code> first.';
  return `<div class="book-form">
    <strong>Book demo</strong> — ${calHint}
    <form method="POST" action="/outbound/book-demo/${encodeURIComponent(r.leadId)}">
      <label>Client email (calendar invite goes here)</label>
      <input type="email" name="attendeeEmail" value="${emailDefault}" required placeholder="owner@facility.com" style="width:100%" />
      <label>Start (Eastern time)</label>
      <input type="datetime-local" name="startAt" required />
      <label>Duration</label>
      <select name="durationMinutes">
        <option value="15">15 min</option>
        <option value="30" selected>30 min</option>
        <option value="45">45 min</option>
      </select>
      ${notesField('bookNotes')}
      <div style="margin-top:8px">
        <button class="btn btn-primary" type="submit">Book demo + send invite</button>
        <a href="${escapeHtml(bookUrl)}" target="_blank" rel="noopener" style="margin-left:8px;font-size:12px">HubSpot scheduler link</a>
      </div>
    </form>
  </div>`;
};

const renderDealStageForm = (
  r: Awaited<ReturnType<typeof buildOutboundRows>>[number],
  stages: DealStageOption[],
): string => {
  if (r.dealId === null) {
    return '<span class="meta">No deal yet — starts on first prep brief or demo book.</span>';
  }
  const options = stages.map((s) => {
    const sel = s.id === r.dealStageId ? ' selected' : '';
    return `<option value="${escapeHtml(s.id)}"${sel}>${escapeHtml(s.label)}</option>`;
  }).join('');
  return `<form class="deal-stage-form" method="POST" action="/outbound/deal-stage/${encodeURIComponent(r.leadId)}">
    <select name="dealstage" onchange="this.form.submit()">${options}</select>
  </form>`;
};

const notesField = (name = 'notes'): string =>
  `<textarea class="notes" name="${name}" placeholder="What did you talk about? (saved to HubSpot notes)"></textarea>`;

const renderStepActions = (
  r: Awaited<ReturnType<typeof buildOutboundRows>>[number],
  calendarOk: boolean,
): string => {
  const step = r.currentStep;
  const base = `/outbound/touch/${encodeURIComponent(r.leadId)}`;
  const prep = r.hubspotCompanyId !== null
    ? ` · <a href="/prep-brief/lead/${encodeURIComponent(r.leadId)}" target="_blank">Prep brief</a>`
    : '';

  if (step === 'cold-call-1') {
    return `<form method="POST" action="${base}">
      <input type="hidden" name="step" value="cold-call-1" />
      ${notesField()}
      <button class="btn btn-connected" name="outcome" value="connected">Connected</button>
      <button class="btn btn-muted" name="outcome" value="no-answer">No answer</button>
    </form>${prep}`;
  }

  if (step === 'voicemail-1') {
    return `<form method="POST" action="${base}">
      <input type="hidden" name="step" value="voicemail-1" />
      ${notesField()}
      <button class="btn btn-primary" name="outcome" value="left">VM left</button>
      <button class="btn btn-muted" name="outcome" value="skipped">Skip VM</button>
    </form>`;
  }

  if (step === 'cold-email') {
    const status = r.coldDraftSent
      ? '<span class="tag">Email sent ✓</span>'
      : r.coldDraftPending
      ? '<a href="/queue?lane=sequence">Approve cold draft →</a>'
      : '<span class="meta">Draft generating… refresh in a minute</span>';
    return `${status}
      <form method="POST" action="/outbound/cold-sent/${encodeURIComponent(r.leadId)}" style="margin-top:8px">
        <button class="btn btn-muted" type="submit">Mark email sent manually</button>
      </form>`;
  }

  if (step === 'cold-call-2') {
    return `<form method="POST" action="${base}">
      <input type="hidden" name="step" value="cold-call-2" />
      ${notesField()}
      <button class="btn btn-connected" name="outcome" value="connected">Connected</button>
      <button class="btn btn-muted" name="outcome" value="no-answer">No answer</button>
    </form>
    ${renderBookDemoForm(r, calendarOk)}${prep}`;
  }

  if (step === 'demo') {
    const when = r.meetingStartAt !== null
      ? `Scheduled: ${escapeHtml(r.meetingStartAt.toISOString().slice(0, 16).replace('T', ' '))}`
      : 'Book a time below or via HubSpot scheduler';
    return `<p class="meta">${when}</p>
      <a class="btn btn-primary" href="/prep-brief/lead/${encodeURIComponent(r.leadId)}" target="_blank" style="display:inline-block;text-decoration:none">Open prep brief</a>
      ${r.meetingStartAt === null ? renderBookDemoForm(r, calendarOk) : ''}
      <form method="POST" action="${base}" style="margin-top:8px">
        <input type="hidden" name="step" value="demo" />
        ${notesField()}
        <button class="btn btn-connected" name="outcome" value="completed">Demo held</button>
        <button class="btn btn-muted" name="outcome" value="no-show">No-show</button>
      </form>`;
  }

  return `<form method="POST" action="${base}">
    <input type="hidden" name="step" value="follow-up" />
    ${notesField()}
    <a href="/queue?lane=replies" class="btn btn-primary" style="text-decoration:none;display:inline-block">Reply drafts</a>
    <button class="btn btn-connected" name="outcome" value="done">Follow-up done</button>
  </form>`;
};

const renderActiveRow = (
  r: Awaited<ReturnType<typeof buildOutboundRows>>[number],
  stages: DealStageOption[],
  calendarOk: boolean,
): string => {
  const stepLabel = OUTBOUND_STEP_LABELS[r.currentStep];
  const hint = OUTBOUND_STEP_HINTS[r.currentStep];
  return `<tr>
    <td><strong>${escapeHtml(r.facility)}</strong><br/>
      <span class="meta">${escapeHtml(r.city)}, ${escapeHtml(r.state)}</span></td>
    <td>${renderPhoneCell(r)}<br/><span class="meta">${escapeHtml(r.hint)}</span></td>
    <td>${escapeHtml(r.ownerName ?? '—')}</td>
    <td>${renderDealStageForm(r, stages)}</td>
    <td><span class="tag tag-step">${escapeHtml(stepLabel)}</span><br/>
      <span class="meta">${escapeHtml(hint)}</span></td>
    <td>${renderStepActions(r, calendarOk)}</td>
  </tr>`;
};

outboundRouter.get('/outbound', queueAuth, async (req, res) => {
  const meetParam = typeof req.query.meet === 'string' ? req.query.meet : '';
  const emailParam = typeof req.query.email === 'string' ? req.query.email : '';
  const flash = typeof req.query.booked === 'string'
    ? `<div class="flash">Demo booked.${emailParam !== '' ? ` Calendar invite sent to ${escapeHtml(emailParam)}.` : ''}${meetParam !== '' ? ` Meet: ${escapeHtml(meetParam)}` : ''}</div>`
    : '';
  const [rows, candidates, stages, calendarOk] = await Promise.all([
    buildOutboundRows({ limit: 100 }),
    buildOutboundStartCandidates({ limit: 12 }),
    loadDealStageOptions(),
    hasCalendarScope(),
  ]);

  const activeBody = rows.length === 0
    ? `<tr><td colspan="6" class="empty">No active outbound sequences.</td></tr>`
    : rows.map((r) => renderActiveRow(r, stages, calendarOk)).join('');

  const startBody = candidates.length === 0
    ? `<tr><td colspan="4" class="empty">No new leads ready — run enrich pipeline first.</td></tr>`
    : candidates.map((c) => `<tr>
      <td><strong>${escapeHtml(c.facility)}</strong><br/><span class="meta">${escapeHtml(c.city)}, ${escapeHtml(c.state)}</span></td>
      <td><a href="tel:${escapeHtml(c.phoneE164)}">${escapeHtml(c.phone)}</a></td>
      <td>${escapeHtml(c.ownerName ?? '—')}</td>
      <td>
        <form method="POST" action="/outbound/start/${encodeURIComponent(c.leadId)}">
          <button class="btn btn-start" type="submit">Start outreach</button>
        </form>
      </td>
    </tr>`).join('');

  const calWarn = calendarOk
    ? ''
    : '<div class="flash flash-warn">Google Calendar scope not active — Book demo will fail until you re-run <code>npx tsx src/scripts/gmailAuth.ts</code> and update <code>GMAIL_REFRESH_TOKEN</code> on Railway.</div>';

  const calNote = 'Two booking paths: (1) <strong>Book demo</strong> form here sends a Google Calendar invite with Meet to the client + logs HubSpot meeting. (2) Your <strong>HubSpot scheduler link</strong> in cold emails — when prospects self-book, HubSpot syncs to Google Calendar if connected in HubSpot Settings → Calendar. Both appear in HubSpot for tracking.';

  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <title>Outbound cadence</title>
  <style>${pageStyles}</style>
</head><body>
  <h1>Outbound cadence</h1>
  <p class="meta">Call 1 → VM 1 → Cold email → Call 2 (demo book) → Demo → Follow-up</p>
  ${flash}
  ${calWarn}
  <div class="disclaimer">${calNote} Notes on each step sync to HubSpot company timeline.</div>
  <div class="toolbar">
    <a href="/queue">← Draft queue</a>
    <a href="/cold-call">Legacy post-email calls</a>
  </div>

  <h2>Active sequences (${String(rows.length)})</h2>
  <table>
    <thead><tr><th>Facility</th><th>Phone</th><th>Owner</th><th>Deal stage</th><th>Step</th><th>Actions</th></tr></thead>
    <tbody>${activeBody}</tbody>
  </table>

  <h2>Start outreach</h2>
  <table>
    <thead><tr><th>Facility</th><th>Phone</th><th>Owner</th><th></th></tr></thead>
    <tbody>${startBody}</tbody>
  </table>
</body></html>`);
});

outboundRouter.post('/outbound/start/:leadId', queueAuth, async (req, res) => {
  const leadId = readLeadId(req);
  if (leadId === null) {
    res.status(400).json({ error: 'invalid lead id' });
    return;
  }
  try {
    await startOutboundSequence(leadId);
    res.redirect(303, '/outbound');
  } catch (err) {
    res.status(400).type('html').send(`<p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p><a href="/outbound">Back</a>`);
  }
});

const TouchSchema = z.object({
  step: z.enum([
    'cold-call-1',
    'voicemail-1',
    'cold-email',
    'cold-call-2',
    'demo',
    'follow-up',
  ]),
  outcome: z.string().min(1),
  notes: z.string().optional(),
});

outboundRouter.post('/outbound/touch/:leadId', queueAuth, async (req, res) => {
  const leadId = readLeadId(req);
  if (leadId === null) {
    res.status(400).json({ error: 'invalid lead id' });
    return;
  }
  const parsed = TouchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid touch payload' });
    return;
  }
  try {
    await logOutboundTouch({
      leadId,
      step: parsed.data.step as OutboundStep,
      outcome: parsed.data.outcome,
      notes: parsed.data.notes,
    });
    res.redirect(303, '/outbound');
  } catch (err) {
    res.status(400).type('html').send(`<p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p><a href="/outbound">Back</a>`);
  }
});

outboundRouter.post('/outbound/cold-sent/:leadId', queueAuth, async (req, res) => {
  const leadId = readLeadId(req);
  if (leadId === null) {
    res.status(400).json({ error: 'invalid lead id' });
    return;
  }
  await logOutboundColdEmailSent(leadId);
  res.redirect(303, '/outbound');
});

const BookSchema = z.object({
  startAt: z.string().min(1),
  attendeeEmail: z.string().email(),
  durationMinutes: z.coerce.number().int().min(15).max(120).optional(),
  bookNotes: z.string().optional(),
});

const DealStageSchema = z.object({
  dealstage: z.string().min(1),
});

outboundRouter.post('/outbound/book-demo/:leadId', queueAuth, async (req, res) => {
  const leadId = readLeadId(req);
  if (leadId === null) {
    res.status(400).json({ error: 'invalid lead id' });
    return;
  }
  const parsed = BookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid booking payload' });
    return;
  }
  try {
    const result = await bookDiscoveryMeeting({
      leadId,
      startAtLocal: parsed.data.startAt,
      attendeeEmail: parsed.data.attendeeEmail,
      durationMinutes: parsed.data.durationMinutes,
      notes: parsed.data.bookNotes,
    });
    const params = new URLSearchParams({ booked: '1', email: result.attendeeEmail });
    if (result.meetUrl !== null) params.set('meet', result.meetUrl);
    res.redirect(303, `/outbound?${params.toString()}`);
  } catch (err) {
    res.status(400).type('html').send(`<p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p><a href="/outbound">Back</a>`);
  }
});

outboundRouter.post('/outbound/deal-stage/:leadId', queueAuth, async (req, res) => {
  const leadId = readLeadId(req);
  if (leadId === null) {
    res.status(400).json({ error: 'invalid lead id' });
    return;
  }
  const parsed = DealStageSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid deal stage' });
    return;
  }
  try {
    const { dealId } = await ensureDealForLead(leadId);
    await updateDealStage({ dealId, stageId: parsed.data.dealstage });
    res.redirect(303, '/outbound');
  } catch (err) {
    res.status(400).type('html').send(`<p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p><a href="/outbound">Back</a>`);
  }
});
