import express from 'express';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, type Draft, type Enrichment, type Lead } from '@prisma/client';
import { z } from 'zod';
import { queueAuth } from '../middleware/queueAuth.js';

const PAGE_SIZE = 30;
// We fetch a window larger than the page so sort=value can rank the full
// backlog (not just the 30 newest) before we slice. Pending queue should
// never realistically exceed this; if it does the operator has bigger problems.
const FETCH_CAP = 200;
const TEXTAREA_ROWS = 12;
const HOLD_TO_CONFIRM_MS = 3000;

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

const renderCard = (d: DraftWithRel, pw: string): string => {
  const enr = d.lead.enrichment;
  const tier = safeTier(enr?.expectedProduct ?? null);
  const pct = d.personalizationPct ?? null;
  const pctLabel = pct === null ? '— personalization' : `${pct}% personalization`;
  const pains = enr === null ? [] : topPainPoints(enr.painPoints);
  const signals = enr === null ? [] : buildSignalLines(enr.signals);
  const subject = d.subject ?? '';
  const pwQs = `?pw=${encodeURIComponent(pw)}`;
  const approveAction = `/approve/${encodeURIComponent(d.id)}${pwQs}`;
  const rejectAction = `/reject/${encodeURIComponent(d.id)}${pwQs}`;

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
  <div class="card">
    <div class="hdr">
      <div class="lead-name">${escapeHtml(d.lead.name)}</div>
      <div class="meta">${escapeHtml(d.lead.city)}, ${escapeHtml(d.lead.state)}${renderSiteLink(d.lead)}</div>
    </div>
    <div class="owner">${renderOwnerLine(enr)}</div>
    ${painsHtml}
    ${signalsHtml}
    <div class="badges">
      <span class="badge solid" style="background:${TIER_BG[tier]}">${escapeHtml(TIER_LABEL[tier])}</span>
      <span class="badge solid" style="background:${personalizationBg(pct)}">${escapeHtml(pctLabel)}</span>
      <span class="badge gray">${escapeHtml(d.kind)}</span>
    </div>
    <form method="post" action="${approveAction}" class="draft-form">
      <input type="text" name="subject" value="${escapeHtml(subject)}" placeholder="(no subject — voicemail or call)" />
      <textarea name="body" rows="${TEXTAREA_ROWS}">${escapeHtml(d.body)}</textarea>
      <input type="text" name="reason" placeholder="reject reason (only sent with Reject)" />
      <div class="actions">
        <button type="submit" class="btn btn-approve">Approve</button>
        <button type="submit" class="btn btn-edit-approve">Edit &amp; Approve</button>
        <button type="submit" class="btn btn-reject" formaction="${rejectAction}">Reject</button>
      </div>
    </form>
    <form method="POST" action="/pause-sequence/${encodeURIComponent(d.lead.id)}" style="display:inline">
      <button type="submit"
        style="background:#f5a623;color:white;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:13px"
        onclick="return confirm('Pause ALL pending emails for this lead?')">
        ⏸ Pause sequence
      </button>
    </form>
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
  .btn-edit-approve { background: #2563eb; color: white; }
  .btn-reject { background: white; color: #b91c1c; border-color: #fecaca; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
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
  drafts: DraftWithRel[],
  totalPending: number,
  sortMode: 'newest' | 'value',
  pw: string,
): string => {
  const newestSel = sortMode === 'newest' ? ' selected' : '';
  const valueSel = sortMode === 'value' ? ' selected' : '';
  const cards =
    drafts.length === 0
      ? '<div class="empty">No pending drafts. Nice work.</div>'
      : drafts.map((d) => renderCard(d, pw)).join('\n');

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
  <div class="top-meta">${totalPending} pending draft${totalPending === 1 ? '' : 's'} · showing ${drafts.length}</div>
  <div class="toolbar">
    <form method="get" action="/queue">
      <input type="hidden" name="pw" value="${escapeHtml(pw)}" />
      <label for="sort">Sort:</label>
      <select id="sort" name="sort" onchange="this.form.submit()">
        <option value="newest"${newestSel}>Newest</option>
        <option value="value"${valueSel}>Commission value (high to low)</option>
      </select>
    </form>
    <button type="button" id="approve-all" class="approve-all"
      title="Hold for 3 seconds to approve every visible draft">
      Hold 3s to approve all visible (${drafts.length})
    </button>
    <span id="approve-all-status" class="approve-status"></span>
  </div>
  ${cards}
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
  const [recent, totalPending] = await Promise.all([
    prisma.draft.findMany({
      where: { status: 'pending' },
      orderBy: { createdAt: 'desc' },
      take: FETCH_CAP,
      include: { lead: { include: { enrichment: true } } },
    }),
    prisma.draft.count({ where: { status: 'pending' } }),
  ]);
  const ordered =
    sortMode === 'value'
      ? [...recent].sort((a, b) => commissionForDraft(b) - commissionForDraft(a))
      : recent;
  const visible = ordered.slice(0, PAGE_SIZE);
  res.type('html').send(renderPage(visible, totalPending, sortMode, pw));
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
  res.redirect(303, `/queue?pw=${encodeURIComponent(readPw(req))}`);
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
  res.redirect(303, `/queue?pw=${encodeURIComponent(readPw(req))}`);
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
