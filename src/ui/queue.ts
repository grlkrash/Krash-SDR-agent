import express from 'express';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, type Draft, type Enrichment, type Lead } from '@prisma/client';
import { z } from 'zod';
import { queueAuth } from '../middleware/queueAuth.js';
import { killLead } from '../outreach/killLead.js';
import { logSentEmailToHubspot } from '../outreach/logSentEmail.js';

const PAGE_SIZE = 30;
// We fetch a window larger than the page so sort=value can rank the full
// backlog (not just the 30 newest) before we slice. Pending queue should
// never realistically exceed this; if it does the operator has bigger problems.
const FETCH_CAP = 200;
const TEXTAREA_ROWS = 12;
const HOLD_TO_CONFIRM_MS = 3000;
const DAY_MS = 86_400_000;
// Paused drafts older than this are treated as stale: the conversation that
// triggered the pause has gone cold, and resuming as-is would queue a draft
// whose facts/signals are months out of date. The undo button is replaced
// with a "Re-draft fresh" button that rejects the stale draft so
// draftColdBatch picks the lead up cleanly on the next cron tick.
const STALE_PAUSE_DAYS = 14;

const COMMISSION = { claimed: 60, select: 240, premium: 960 } as const;
type Tier = keyof typeof COMMISSION;

const TIER_LABEL: Record<Tier, string> = {
  claimed: '$60 Claimed',
  select: '$240 Select',
  premium: '$960 Premium',
};
const TIER_BG: Record<Tier, string> = {
  claimed: '#6b7280',
  select: '#3b82f6',
  premium: '#d4a017',
};

const PCT_GREEN_FLOOR = 70;
const PCT_YELLOW_FLOOR = 60;
const PCT_BG_GREEN = '#16a34a';
const PCT_BG_YELLOW = '#ca8a04';
const PCT_BG_RED = '#dc2626';
const PCT_BG_UNKNOWN = '#6b7280';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const SignalsSchema = z
  .object({
    competingDirectories: z
      .object({ missingFromAll: z.boolean().optional() })
      .partial()
      .optional(),
    hiring: z
      .object({
        active: z.boolean().optional(),
        roleTitles: z.array(z.string()).optional(),
      })
      .partial()
      .optional(),
    techStack: z
      .object({ bigSpenderScore: z.number().optional() })
      .partial()
      .optional(),
  })
  .partial();

const PainPointsSchema = z.record(z.string(), z.boolean());

const ApproveBodySchema = z.object({
  subject: z.string().optional(),
  body: z.string().optional(),
});

const RejectBodySchema = z.object({
  reason: z.string().optional(),
});

const KillLeadBodySchema = z.object({
  reason: z.string().optional(),
});

const DEFAULT_KILL_REASON = 'no reason given';

type DraftWithRel = Draft & { lead: Lead & { enrichment: Enrichment | null } };

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });

const safeTier = (v: string | null | undefined): Tier => {
  if (v === 'select' || v === 'premium') return v;
  return 'claimed';
};

const personalizationBg = (pct: number | null): string => {
  if (pct === null) return PCT_BG_UNKNOWN;
  if (pct >= PCT_GREEN_FLOOR) return PCT_BG_GREEN;
  if (pct >= PCT_YELLOW_FLOOR) return PCT_BG_YELLOW;
  return PCT_BG_RED;
};

const commissionForDraft = (d: DraftWithRel): number =>
  COMMISSION[safeTier(d.lead.enrichment?.expectedProduct ?? null)];

const buildSignalLines = (signalsJson: Prisma.JsonValue): string[] => {
  const parsed = SignalsSchema.safeParse(signalsJson);
  if (!parsed.success) return [];
  const s = parsed.data;
  const lines: string[] = [];
  if (s.competingDirectories?.missingFromAll === true) {
    lines.push('🎯 Missing from PT + Rehabs + Recovery.com');
  }
  if (s.hiring?.active === true) {
    const titles = (s.hiring.roleTitles ?? []).slice(0, 2).join(', ');
    lines.push(`📈 Hiring ${titles}`);
  }
  const score = s.techStack?.bigSpenderScore ?? 0;
  if (score >= 2) {
    lines.push(`💰 ${score} marketing tools detected`);
  }
  return lines;
};

const TOP_PAIN_POINTS = 2;

const topPainPoints = (painPointsJson: Prisma.JsonValue): string[] => {
  const parsed = PainPointsSchema.safeParse(painPointsJson);
  if (!parsed.success) return [];
  return Object.entries(parsed.data)
    .filter(([, v]) => v === true)
    .map(([k]) => k)
    .slice(0, TOP_PAIN_POINTS);
};

const renderOwnerLine = (enr: Enrichment | null): string => {
  const name = enr?.ownerName ?? null;
  if (name === null) return 'Owner: <span class="dim">unknown</span>';
  const li = enr?.ownerLinkedIn ?? null;
  if (li === null) return `Owner: ${escapeHtml(name)}`;
  return `Owner: ${escapeHtml(name)} · <a href="${escapeHtml(li)}" target="_blank" rel="noopener">LinkedIn</a>`;
};

const renderSiteLink = (lead: Lead): string => {
  if (lead.website === null) return '';
  return ` · <a href="${escapeHtml(lead.website)}" target="_blank" rel="noopener">site</a>`;
};

// Cookie-based auth (per Security Prompt S.1) — no ?pw= on this URL. The
// /prep-brief/lookup handler resolves the company → first associated deal
// and redirects to /prep-brief/{dealId}.
const renderPrepBriefLink = (lead: Lead): string => {
  if (lead.hubspotCompanyId === null) return '';
  const href = `/prep-brief/lookup?companyId=${encodeURIComponent(lead.hubspotCompanyId)}`;
  return `<a href="${href}" target="_blank" style="font-size:12px;color:#666;text-decoration:none;margin-left:8px">📋 Prep Brief</a>`;
};

const renderHeader = (d: DraftWithRel): string => {
  const enr = d.lead.enrichment;
  const tier = safeTier(enr?.expectedProduct ?? null);
  const pct = d.personalizationPct ?? null;
  const pctLabel = pct === null ? '— personalization' : `${pct}% personalization`;
  const pains = enr === null ? [] : topPainPoints(enr.painPoints);
  const signals = enr === null ? [] : buildSignalLines(enr.signals);

  const painsHtml =
    pains.length === 0
      ? ''
      : `<div class="pains">${pains
          .map((p) => `<span class="badge gray">${escapeHtml(p)}</span>`)
          .join('')}</div>`;

  const signalsHtml =
    signals.length === 0
      ? ''
      : `<div class="signals">${signals
          .map((line) => `<div class="signal">${escapeHtml(line)}</div>`)
          .join('')}</div>`;

  return `
    <div class="hdr">
      <div class="lead-name">${escapeHtml(d.lead.name)}</div>
      <div class="meta">${escapeHtml(d.lead.city)}, ${escapeHtml(d.lead.state)}${renderSiteLink(d.lead)}</div>
    </div>
    <div class="owner">${renderOwnerLine(enr)}${renderPrepBriefLink(d.lead)}</div>
    ${painsHtml}
    ${signalsHtml}
    <div class="badges">
      <span class="badge solid" style="background:${TIER_BG[tier]}">${escapeHtml(TIER_LABEL[tier])}</span>
      <span class="badge solid" style="background:${personalizationBg(pct)}">${escapeHtml(pctLabel)}</span>
      <span class="badge gray">${escapeHtml(d.kind)}</span>
    </div>`;
};

const renderPauseForm = (d: DraftWithRel): string =>
  `<form method="POST" action="/pause-sequence/${encodeURIComponent(d.lead.id)}" style="display:inline">
      <button type="submit"
        style="background:#f5a623;color:white;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:13px"
        onclick="return confirm('Pause ALL pending emails for this lead?')">
        ⏸ Pause sequence
      </button>
    </form>`;

// "Kill lead" stops ALL outreach for this lead permanently. Stronger than
// pause: marks Lead.doNotContact=true, writes a Suppression row keyed on the
// known email/phone, cancels every active draft, and flips the HubSpot
// contact's hs_lead_status to UNQUALIFIED. Uses an HTML prompt() in JS so
// Sonia can type a reason at click time; the reason goes into AuditLog +
// the cancelled drafts' rejectReason.
const renderKillLeadForm = (d: DraftWithRel): string =>
  `<form method="POST" action="/kill-lead/${encodeURIComponent(d.lead.id)}" style="display:inline" onsubmit="return killLeadPrompt(this)">
      <input type="hidden" name="reason" value="" />
      <button type="submit" class="btn-kill"
        title="Stop ALL outreach for this lead and tell HubSpot the contact is unqualified">
        Kill lead
      </button>
    </form>`;

const renderPendingCard = (d: DraftWithRel, pw: string): string => {
  const subject = d.subject ?? '';
  const pwQs = `?pw=${encodeURIComponent(pw)}`;
  const approveAction = `/approve/${encodeURIComponent(d.id)}${pwQs}`;
  const rejectAction = `/reject/${encodeURIComponent(d.id)}${pwQs}`;

  return `
  <div class="card">
    ${renderHeader(d)}
    <form method="post" action="${approveAction}" class="draft-form">
      <input type="text" name="subject" value="${escapeHtml(subject)}" placeholder="(no subject — voicemail or call)" />
      <textarea name="body" rows="${TEXTAREA_ROWS}">${escapeHtml(d.body)}</textarea>
      <input type="text" name="reason" placeholder="reject reason (only sent with Reject)" />
      <div class="actions">
        <button type="submit" class="btn btn-approve">Approve</button>
        <button type="submit" class="btn btn-reject" formaction="${rejectAction}">Reject</button>
      </div>
    </form>
    <div class="lead-actions">
      ${renderPauseForm(d)}
      ${renderKillLeadForm(d)}
    </div>
  </div>`;
};

const renderApprovedCard = (d: DraftWithRel): string => {
  const subjectText = d.subject ?? '';
  const subjectHtml =
    subjectText === ''
      ? `<pre class="email-text subject empty">(no subject — voicemail or call)</pre>`
      : `<pre class="email-text subject">${escapeHtml(subjectText)}</pre>`;
  return `
  <div class="card approved-card">
    ${renderHeader(d)}
    <div class="approved-email">
      <div class="email-field">
        <div class="email-label">Subject</div>
        ${subjectHtml}
      </div>
      <div class="email-field">
        <div class="email-label">Body</div>
        <pre class="email-text body">${escapeHtml(d.body)}</pre>
      </div>
    </div>
    <div class="approved-actions">
      ${renderMarkSentForm(d)}
      ${renderPauseForm(d)}
      ${renderKillLeadForm(d)}
    </div>
  </div>`;
};

// Shown only after the draft is approved — lets Sonia confirm she sent the
// email from Gmail by hand so the follow-up sequencer counts from the right
// timestamp. Removed once Gmail API send is wired up.
const renderMarkSentForm = (d: DraftWithRel): string => {
  if (d.status !== 'approved') return '';
  return `<form method="POST" action="/mark-sent/${encodeURIComponent(d.id)}" style="display:inline">
      <button type="submit"
        style="background:#5a8f5a;color:white;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:13px"
        title="Use when sending from Gmail directly — triggers auto follow-ups">
        ✓ Sent manually
      </button>
    </form>`;
};

// Compact one-line row for the paused/rejected undo zone. Read-only summary
// (lead name, location, kind, status pill, optional reason) plus a single
// Undo button that flips this draft back to pending. We deliberately don't
// render badges/signals/painPoints here — this section is for triage, not
// review.
const REASON_PREVIEW_MAX = 120;

const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const isStalePaused = (d: DraftWithRel): boolean =>
  d.status === 'paused' && Date.now() - d.createdAt.getTime() > STALE_PAUSE_DAYS * DAY_MS;

const renderUndoRow = (d: DraftWithRel): string => {
  const statusClass = d.status === 'paused' ? 'status-paused' : 'status-rejected';
  const reason = d.rejectReason ?? '';
  const reasonHtml =
    reason === ''
      ? ''
      : `<span class="undo-reason">${escapeHtml(truncate(reason, REASON_PREVIEW_MAX))}</span>`;
  const restoreForm = isStalePaused(d)
    ? `<form method="POST" action="/redraft/${encodeURIComponent(d.id)}" style="display:inline" onsubmit="return confirm('Discard this stale paused draft so a fresh one is generated tomorrow?')">
        <button type="submit" class="btn-undo" style="background:#0d9488" title="Reject stale draft and re-enter cold-draft pool">↻ Re-draft fresh</button>
      </form>`
    : `<form method="POST" action="/undo/${encodeURIComponent(d.id)}" style="display:inline">
        <button type="submit" class="btn-undo" title="Restore to pending">↩ Undo</button>
      </form>`;
  return `
  <div class="undo-row">
    <div class="undo-info">
      <span class="lead-name-sm">${escapeHtml(d.lead.name)}</span>
      <span class="undo-meta">${escapeHtml(d.lead.city)}, ${escapeHtml(d.lead.state)} · ${escapeHtml(d.kind)}</span>
      <span class="undo-status ${statusClass}">${escapeHtml(d.status)}</span>
      ${reasonHtml}
    </div>
    <div class="undo-actions">
      ${restoreForm}
      ${renderKillLeadForm(d)}
    </div>
  </div>`;
};

const STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 760px; margin: 0 auto; padding: 24px 16px 80px; color: #111; background: #f7f7f8; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .top-meta { color: #6b7280; font-size: 13px; margin-bottom: 12px; }
  .toolbar { display: flex; gap: 12px; align-items: center; margin: 12px 0 20px; flex-wrap: wrap; }
  .toolbar form { display: inline-flex; gap: 6px; align-items: center; margin: 0; }
  .toolbar label { font-size: 13px; color: #374151; }
  .toolbar select { font-size: 14px; padding: 6px 10px; border-radius: 6px; border: 1px solid #d4d4d8; background: white; }
  .approve-all { background: #1d4ed8; color: white; border: none; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-weight: 600; user-select: none; }
  .approve-all[disabled] { opacity: 0.6; cursor: progress; }
  .approve-all.armed { background: #b91c1c; }
  .approve-status { font-size: 13px; color: #6b7280; }
  .empty { padding: 40px; text-align: center; color: #6b7280; background: white; border: 1px solid #e5e7eb; border-radius: 8px; }
  .queue-section { margin-top: 28px; }
  .queue-section:first-of-type { margin-top: 0; }
  .section-title { font-size: 16px; font-weight: 600; margin: 0 0 12px; color: #1f2937; display: flex; align-items: baseline; gap: 8px; }
  .section-title .count { font-weight: 400; font-size: 14px; color: #6b7280; }
  .section-empty { padding: 20px; text-align: center; color: #6b7280; background: white; border: 1px dashed #e5e7eb; border-radius: 8px; }
  .approved-email { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-top: 12px; }
  .email-field + .email-field { margin-top: 10px; }
  .email-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 4px; }
  .email-text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.5; color: #0f172a; white-space: pre-wrap; word-wrap: break-word; margin: 0; background: white; border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 10px; user-select: text; cursor: text; }
  .email-text.subject { font-weight: 500; }
  .email-text.empty { color: #9ca3af; font-style: italic; }
  .approved-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .lead-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .undo-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .undo-row { background: white; border: 1px solid #e5e7eb; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .undo-info { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; color: #374151; flex: 1; min-width: 0; }
  .lead-name-sm { font-weight: 600; color: #111; font-size: 14px; }
  .undo-meta { color: #6b7280; }
  .undo-status { font-size: 11px; padding: 2px 8px; border-radius: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.03em; }
  .status-paused { background: #fef3c7; color: #92400e; }
  .status-rejected { background: #fee2e2; color: #991b1b; }
  .undo-reason { color: #6b7280; font-style: italic; font-size: 12px; flex-basis: 100%; word-wrap: break-word; }
  .btn-undo { background: #475569; color: white; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; flex-shrink: 0; }
  .btn-undo:hover { background: #334155; }
  .card { background: white; border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .hdr { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .lead-name { font-weight: 600; font-size: 16px; }
  .meta { color: #6b7280; font-size: 13px; }
  .owner { color: #374151; font-size: 14px; margin-top: 4px; }
  .dim { color: #9ca3af; }
  .pains, .badges { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px; }
  .signals { margin-top: 8px; display: flex; flex-direction: column; gap: 2px; font-size: 13px; color: #374151; }
  .badge { display: inline-block; font-size: 12px; padding: 3px 8px; border-radius: 12px; line-height: 1.4; }
  .badge.gray { background: #e5e7eb; color: #374151; }
  .badge.solid { color: white; }
  .draft-form { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
  .draft-form input[type=text], .draft-form textarea { width: 100%; box-sizing: border-box; font-family: inherit; font-size: 14px; padding: 8px; border: 1px solid #d4d4d8; border-radius: 6px; }
  .draft-form textarea { resize: vertical; line-height: 1.45; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn { font-size: 14px; padding: 6px 12px; border-radius: 6px; border: 1px solid transparent; cursor: pointer; font-weight: 500; }
  .btn-approve { background: #16a34a; color: white; }
  .btn-reject { background: white; color: #b91c1c; border-color: #fecaca; }
  .btn-kill { background: #dc2626; color: white; border: none; padding: 6px 14px; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500; }
  .btn-kill:hover { background: #b91c1c; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
`;

// Two-step confirm for the Kill lead button: a confirm() with the consequences,
// then a prompt() for the reason. The reason is stamped into the hidden
// input on the same form. Cancel at either step aborts the submit.
const KILL_LEAD_SCRIPT = `
window.killLeadPrompt = function (form) {
  if (!window.confirm('Kill this lead?\\n\\nThis cancels every active draft, suppresses the email, and tells HubSpot the contact is UNQUALIFIED.')) return false;
  var reason = window.prompt('Reason for killing this lead?', '') || '';
  var input = form.querySelector('input[name="reason"]');
  if (input) input.value = reason;
  return true;
};
`;

const HOLD_SCRIPT = `
(function () {
  var btn = document.getElementById('approve-all');
  if (!btn) return;
  var status = document.getElementById('approve-all-status');
  var HOLD_MS = ${HOLD_TO_CONFIRM_MS};
  var timer = null;
  var firing = false;
  function cancel() {
    if (timer) { clearTimeout(timer); timer = null; }
    btn.classList.remove('armed');
    if (status && !firing) status.textContent = '';
  }
  function arm(e) {
    if (e && e.preventDefault) e.preventDefault();
    cancel();
    btn.classList.add('armed');
    if (status) status.textContent = 'Keep holding to approve all visible…';
    timer = setTimeout(fire, HOLD_MS);
  }
  function fire() {
    firing = true;
    btn.classList.remove('armed');
    btn.disabled = true;
    if (status) status.textContent = 'Approving…';
    var forms = Array.prototype.slice.call(document.querySelectorAll('form.draft-form'));
    (async function () {
      var ok = 0;
      var fail = 0;
      for (var i = 0; i < forms.length; i++) {
        var f = forms[i];
        try {
          var res = await fetch(f.action, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(new FormData(f)).toString(),
            redirect: 'manual',
            credentials: 'same-origin',
          });
          if (res.type === 'opaqueredirect' || (res.status >= 200 && res.status < 400)) ok++; else fail++;
        } catch (e) { fail++; }
        if (status) status.textContent = 'Approving… ' + (i + 1) + '/' + forms.length;
      }
      if (status) status.textContent = 'Done: ' + ok + ' approved, ' + fail + ' failed. Reloading…';
      window.location.reload();
    })();
  }
  btn.addEventListener('mousedown', arm);
  btn.addEventListener('touchstart', arm);
  btn.addEventListener('mouseup', cancel);
  btn.addEventListener('mouseleave', cancel);
  btn.addEventListener('touchend', cancel);
  btn.addEventListener('touchcancel', cancel);
})();
`;

const renderPage = (
  pending: DraftWithRel[],
  approved: DraftWithRel[],
  pausedRejected: DraftWithRel[],
  totalPending: number,
  totalApproved: number,
  totalPausedRejected: number,
  sortMode: 'newest' | 'value',
  pw: string,
): string => {
  const newestSel = sortMode === 'newest' ? ' selected' : '';
  const valueSel = sortMode === 'value' ? ' selected' : '';
  const pendingCards =
    pending.length === 0
      ? '<div class="section-empty">No pending drafts. Nice work.</div>'
      : pending.map((d) => renderPendingCard(d, pw)).join('\n');
  const approvedCards =
    approved.length === 0
      ? '<div class="section-empty">Nothing waiting to send.</div>'
      : approved.map((d) => renderApprovedCard(d)).join('\n');
  // Hide the undo section entirely when nothing is paused/rejected — it's a
  // tool that's only relevant when there's something to fix.
  const undoSection =
    totalPausedRejected === 0
      ? ''
      : `
  <section class="queue-section" id="undo-zone">
    <h2 class="section-title">🗄 Recently paused / rejected <span class="count">(${totalPausedRejected})</span></h2>
    ${pausedRejected.map((d) => renderUndoRow(d)).join('\n')}
  </section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Approval Queue (${totalPending})</title>
<style>${STYLE}</style>
</head>
<body>
  <h1>Approval Queue</h1>
  <div class="top-meta">${totalPending} pending · ${totalApproved} approved &amp; ready to send${totalPausedRejected > 0 ? ` · <a href="#undo-zone">${totalPausedRejected} to undo ↓</a>` : ''}</div>
  <div class="toolbar">
    <form method="get" action="/queue">
      <input type="hidden" name="pw" value="${escapeHtml(pw)}" />
      <label for="sort">Sort pending:</label>
      <select id="sort" name="sort" onchange="this.form.submit()">
        <option value="newest"${newestSel}>Newest</option>
        <option value="value"${valueSel}>Commission value (high to low)</option>
      </select>
    </form>
    <button type="button" id="approve-all" class="approve-all"
      title="Hold for 3 seconds to approve every visible pending draft">
      Hold 3s to approve all visible (${pending.length})
    </button>
    <span id="approve-all-status" class="approve-status"></span>
  </div>
  <section class="queue-section">
    <h2 class="section-title">📋 Pending review <span class="count">(${totalPending})</span></h2>
    ${pendingCards}
  </section>
  <section class="queue-section">
    <h2 class="section-title">✉️ Approved — ready to send <span class="count">(${totalApproved})</span></h2>
    ${approvedCards}
  </section>${undoSection}
  <script>${KILL_LEAD_SCRIPT}</script>
  <script>${HOLD_SCRIPT}</script>
</body>
</html>`;
};

const readPw = (req: express.Request): string => {
  const q = req.query.pw;
  return typeof q === 'string' ? q : '';
};

const readId = (req: express.Request): string | null => {
  const raw = req.params.id;
  if (typeof raw !== 'string' || raw === '') return null;
  return raw;
};

export const queueRouter = express.Router();
queueRouter.use(express.urlencoded({ extended: false }));

queueRouter.get('/queue', queueAuth, async (req, res) => {
  const sortMode: 'newest' | 'value' = req.query.sort === 'value' ? 'value' : 'newest';
  const pw = readPw(req);
  // Three separate fetches so each section is paged independently and one
  // status can't crowd out another under FETCH_CAP. Approved + paused/rejected
  // are always newest-first; the value-sort dropdown only re-ranks pending.
  const [pendingRows, approvedRows, pausedRejectedRows, totalPending, totalApproved, totalPausedRejected] =
    await Promise.all([
      prisma.draft.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'desc' },
        take: FETCH_CAP,
        include: { lead: { include: { enrichment: true } } },
      }),
      prisma.draft.findMany({
        where: { status: 'approved' },
        orderBy: { createdAt: 'desc' },
        take: FETCH_CAP,
        include: { lead: { include: { enrichment: true } } },
      }),
      prisma.draft.findMany({
        where: { status: { in: ['paused', 'rejected'] } },
        orderBy: { createdAt: 'desc' },
        take: FETCH_CAP,
        include: { lead: { include: { enrichment: true } } },
      }),
      prisma.draft.count({ where: { status: 'pending' } }),
      prisma.draft.count({ where: { status: 'approved' } }),
      prisma.draft.count({ where: { status: { in: ['paused', 'rejected'] } } }),
    ]);
  const orderedPending =
    sortMode === 'value'
      ? [...pendingRows].sort((a, b) => commissionForDraft(b) - commissionForDraft(a))
      : pendingRows;
  const visiblePending = orderedPending.slice(0, PAGE_SIZE);
  const visibleApproved = approvedRows.slice(0, PAGE_SIZE);
  const visiblePausedRejected = pausedRejectedRows.slice(0, PAGE_SIZE);
  res
    .type('html')
    .send(
      renderPage(
        visiblePending,
        visibleApproved,
        visiblePausedRejected,
        totalPending,
        totalApproved,
        totalPausedRejected,
        sortMode,
        pw,
      ),
    );
});

queueRouter.post('/approve/:id', queueAuth, async (req, res) => {
  const id = readId(req);
  if (id === null) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const parsed = ApproveBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }
  const existing = await prisma.draft.findUnique({
    where: { id },
    select: { subject: true, body: true, status: true },
  });
  if (existing === null) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const subjectChanged =
    parsed.data.subject !== undefined && parsed.data.subject !== (existing.subject ?? '');
  const bodyChanged = parsed.data.body !== undefined && parsed.data.body !== existing.body;
  const update: Prisma.DraftUpdateInput = {
    status: 'approved',
    approvedBy: 'sonia',
    ...(subjectChanged ? { subject: parsed.data.subject } : {}),
    ...(bodyChanged ? { body: parsed.data.body } : {}),
  };
  await prisma.draft.update({ where: { id }, data: update });
  await prisma.auditLog.create({
    data: {
      action: 'queue.approve',
      entity: 'draft',
      entityId: id,
      meta: {
        approvedBy: 'sonia',
        subjectChanged,
        bodyChanged,
        previousStatus: existing.status,
      },
    },
  });
  res.redirect(303, '/queue');
});

queueRouter.post('/reject/:id', queueAuth, async (req, res) => {
  const id = readId(req);
  if (id === null) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const parsed = RejectBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }
  const reason = parsed.data.reason?.trim() ?? '';
  const existing = await prisma.draft.findUnique({
    where: { id },
    select: { status: true },
  });
  if (existing === null) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  await prisma.draft.update({
    where: { id },
    data: {
      status: 'rejected',
      rejectReason: reason === '' ? null : reason,
    },
  });
  await prisma.auditLog.create({
    data: {
      action: 'queue.reject',
      entity: 'draft',
      entityId: id,
      meta: { reason, previousStatus: existing.status },
    },
  });
  res.redirect(303, '/queue');
});

queueRouter.post('/mark-sent/:id', queueAuth, async (req, res) => {
  const id = readId(req);
  if (id === null) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const existing = await prisma.draft.findUnique({
    where: { id },
    select: { leadId: true },
  });
  if (existing === null) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  await prisma.draft.update({
    where: { id },
    data: {
      status: 'sent',
      sentAt: new Date(),
      approvedBy: 'sonia',
    },
  });
  await prisma.auditLog.create({
    data: {
      action: 'draft.marked-sent-manually',
      entity: 'Draft',
      entityId: id,
      meta: { leadId: existing.leadId },
    },
  });
  // Best-effort HubSpot engagement log so the contact's timeline shows the
  // send. Never throws — internal try/catch + AuditLog. We do this AFTER the
  // DB-side 'sent' flip so the source of truth is correct even if HubSpot
  // is down.
  await logSentEmailToHubspot(id);
  res.redirect(303, '/queue');
});

// Single-draft restore from paused/rejected → pending. Only valid from those
// two statuses — refuses to clobber pending/approved/sent. Resets rejectReason
// so the draft re-enters the queue clean. Approves/rejects the draft from
// scratch on next review (we don't try to remember a prior approval state).
queueRouter.post('/undo/:id', queueAuth, async (req, res) => {
  const id = readId(req);
  if (id === null) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const existing = await prisma.draft.findUnique({
    where: { id },
    select: { status: true, rejectReason: true },
  });
  if (existing === null) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (existing.status !== 'paused' && existing.status !== 'rejected') {
    res.status(400).json({ error: `cannot undo from status ${existing.status}` });
    return;
  }
  await prisma.draft.update({
    where: { id },
    data: { status: 'pending', rejectReason: null },
  });
  await prisma.auditLog.create({
    data: {
      action: 'queue.restore',
      entity: 'draft',
      entityId: id,
      meta: {
        previousStatus: existing.status,
        previousReason: existing.rejectReason,
        restoredBy: 'sonia',
      },
    },
  });
  res.redirect(303, '/queue');
});

// Stale-paused resume path. Rather than restoring a months-old draft as-is
// (its facts/signals would be out of date), reject it so draftColdBatch's
// eligibility query (status NOT 'rejected') re-includes the lead and a
// fresh draft is generated on the next cron tick. Only valid from 'paused';
// rejected drafts already have an explicit re-draft path via the cron's
// MAX_REJECTS_PER_LEAD logic.
queueRouter.post('/redraft/:id', queueAuth, async (req, res) => {
  const id = readId(req);
  if (id === null) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const existing = await prisma.draft.findUnique({
    where: { id },
    select: { status: true, leadId: true, createdAt: true },
  });
  if (existing === null) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  if (existing.status !== 'paused') {
    res.status(400).json({ error: `cannot redraft from status ${existing.status}` });
    return;
  }
  await prisma.draft.update({
    where: { id },
    data: { status: 'rejected', rejectReason: 'auto-redraft on resume (stale)' },
  });
  await prisma.auditLog.create({
    data: {
      action: 'queue.redraft-on-resume',
      entity: 'Draft',
      entityId: id,
      meta: {
        leadId: existing.leadId,
        ageDays: Math.floor((Date.now() - existing.createdAt.getTime()) / DAY_MS),
      },
    },
  });
  res.redirect(303, '/queue');
});

queueRouter.post('/pause-sequence/:leadId', queueAuth, async (req, res) => {
  const leadId = req.params.leadId;
  if (typeof leadId !== 'string' || leadId === '') {
    res.status(400).json({ error: 'invalid leadId' });
    return;
  }
  const result = await prisma.draft.updateMany({
    where: { leadId, status: { in: ['pending', 'approved'] } },
    data: { status: 'paused', rejectReason: 'Manually paused — sequence hold' },
  });
  await prisma.auditLog.create({
    data: {
      action: 'sequence.paused',
      entity: 'Lead',
      entityId: leadId,
      meta: { pausedBy: 'sonia', count: result.count },
    },
  });
  res.redirect(303, '/queue');
});

// Hard stop for a lead. Delegates to outreach/killLead which handles
// Lead.doNotContact, Suppression upsert, active-draft cancellation, and the
// HubSpot hs_lead_status=UNQUALIFIED flip. HubSpot failures are non-fatal —
// killLead writes its own AuditLog row for that case.
queueRouter.post('/kill-lead/:leadId', queueAuth, async (req, res) => {
  const leadId = req.params.leadId;
  if (typeof leadId !== 'string' || leadId === '') {
    res.status(400).json({ error: 'invalid leadId' });
    return;
  }
  const parsed = KillLeadBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body' });
    return;
  }
  const reason = parsed.data.reason?.trim() ?? '';
  const effectiveReason = reason === '' ? DEFAULT_KILL_REASON : reason;
  await killLead(leadId, effectiveReason);
  res.redirect(303, '/queue');
});
