import express from 'express';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { queueAuth } from '../middleware/queueAuth.js';
import {
  MANUAL_VM_CALLED_STATUS,
  MANUAL_VM_QUEUE_LIMIT,
  MANUAL_VM_SKIPPED_STATUS,
  buildManualVoicemailRows,
} from '../outreach/brief/manualVm.js';
import { MATRIX_VERSION } from '../shared/voicemailStateMatrix.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const DraftIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9]+$/);

export const manualVmQueueRouter = express.Router();

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });

const readId = (req: express.Request): string | null => {
  const result = DraftIdSchema.safeParse(req.params.id);
  return result.success ? result.data : null;
};

const pageStyles = `
  body { font-family: system-ui, sans-serif; margin: 24px; max-width: 960px; color: #111; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .meta { color: #64748b; font-size: 14px; margin-bottom: 16px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 20px; }
  .toolbar a { color: #2563eb; text-decoration: none; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { border: 1px solid #e2e8f0; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { background: #f8fafc; }
  .btn { padding: 6px 12px; border-radius: 6px; border: none; font-weight: 600; cursor: pointer; font-size: 13px; }
  .btn-called { background: #16a34a; color: #fff; }
  .btn-consent { background: #3b82f6; color: #fff; margin-left: 6px; }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: #fef3c7; color: #92400e; }
  .empty { color: #64748b; padding: 24px 0; }
  .disclaimer { background: #fff7ed; border: 1px solid #fdba74; padding: 10px; border-radius: 8px;
    font-size: 13px; margin-bottom: 16px; }
`;

const renderRow = (r: Awaited<ReturnType<typeof buildManualVoicemailRows>>[number]): string => {
  const owner = r.ownerName ?? '—';
  const consentBtn = r.priorWrittenConsent
    ? '<span class="tag">consent on file</span>'
    : `<form method="POST" action="/manual-vm-queue/consent/${encodeURIComponent(r.draftId)}" style="display:inline"
         onsubmit="return confirm('Documented prior express written consent on file for this lead?')">
         <button type="submit" class="btn btn-consent" title="Only after documented written consent">Grant consent</button>
       </form>`;
  return `<tr>
    <td><strong>${escapeHtml(r.facility)}</strong><br/>
      <span class="meta">${escapeHtml(r.city)}, ${escapeHtml(r.state)}</span></td>
    <td><a href="tel:${escapeHtml(r.phoneE164)}">${escapeHtml(r.phone)}</a></td>
    <td>${escapeHtml(owner)}</td>
    <td>${escapeHtml(r.hint)}<br/><span class="tag">${escapeHtml(r.reason)}</span></td>
    <td>${escapeHtml(r.flaggedAt.toISOString().slice(0, 10))}</td>
    <td>
      <form method="POST" action="/manual-vm-called/${encodeURIComponent(r.draftId)}"
        onsubmit="return confirm('Mark this lead as manually called?')">
        <button type="submit" class="btn btn-called">✓ Called</button>
      </form>
      ${consentBtn}
    </td>
  </tr>`;
};

manualVmQueueRouter.get('/manual-vm-queue', queueAuth, async (_req, res) => {
  const rows = await buildManualVoicemailRows({
    limit: MANUAL_VM_QUEUE_LIMIT,
    includeCalled: false,
  });
  const matrixCmd = 'npm run compliance:matrix';
  const tableBody = rows.length === 0
    ? `<tr><td colspan="6" class="empty">No open manual VM leads — you're caught up.</td></tr>`
    : rows.map(renderRow).join('');

  res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8" />
  <title>Manual VM queue</title>
  <style>${pageStyles}</style>
</head><body>
  <h1>Manual VM queue</h1>
  <p class="meta">State-law restricted leads (FL, OK, WA, IN, MA, TX, CA) · matrix v${escapeHtml(MATRIX_VERSION)}</p>
  <div class="disclaimer">Not legal advice. Mark <strong>Called</strong> after you place the manual voicemail or live call.
    Leads stay here until marked — they do not roll off after 24h.</div>
  <div class="toolbar">
    <a href="/queue">← Draft queue</a>
    <span>Generate counsel PDF: <code>${escapeHtml(matrixCmd)}</code> → <code>data/exports/</code></span>
  </div>
  <table>
    <thead><tr>
      <th>Facility</th><th>Phone</th><th>Owner</th><th>When / reason</th><th>Flagged</th><th>Action</th>
    </tr></thead>
    <tbody>${tableBody}</tbody>
  </table>
</body></html>`);
});

manualVmQueueRouter.post('/manual-vm-called/:id', queueAuth, async (req, res) => {
  const id = readId(req);
  if (id === null) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const existing = await prisma.draft.findUnique({
    where: { id },
    select: { status: true, leadId: true },
  });
  if (existing === null || existing.status !== MANUAL_VM_SKIPPED_STATUS) {
    res.status(404).json({ error: 'not found or not open' });
    return;
  }
  await prisma.draft.update({
    where: { id },
    data: { status: MANUAL_VM_CALLED_STATUS },
  });
  await prisma.auditLog.create({
    data: {
      action: 'manualVm.marked-called',
      entity: 'Draft',
      entityId: id,
      meta: { leadId: existing.leadId },
    },
  });
  res.redirect(303, '/manual-vm-queue');
});

manualVmQueueRouter.post('/manual-vm-queue/consent/:id', queueAuth, async (req, res) => {
  const id = readId(req);
  if (id === null) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const draft = await prisma.draft.findUnique({
    where: { id },
    select: { leadId: true, status: true },
  });
  if (draft === null) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const now = new Date();
  await prisma.lead.update({
    where: { id: draft.leadId },
    data: { priorWrittenConsent: true, priorWrittenConsentAt: now },
  });
  // Retire the state-law tombstone so dropVoicemails can draft a real VM
  // on the next cron tick now that consent is on file.
  if (draft.status === MANUAL_VM_SKIPPED_STATUS) {
    await prisma.draft.update({
      where: { id },
      data: { status: 'rejected', rejectReason: 'superseded-prior-written-consent' },
    });
  }
  await prisma.auditLog.create({
    data: {
      action: 'lead.prior-written-consent',
      entity: 'Lead',
      entityId: draft.leadId,
      meta: { draftId: id, grantedAt: now.toISOString() },
    },
  });
  res.redirect(303, '/manual-vm-queue');
});
