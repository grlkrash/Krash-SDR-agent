import {
  MATRIX_COUNSEL_DISCLAIMER,
  MATRIX_VERSION,
  NON_US_MATRIX_ROWS,
  PRIOR_WRITTEN_CONSENT_NOTE,
  buildVoicemailMatrixRows,
  type VoicemailMatrixRow,
} from './voicemailStateMatrix.js';

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });

const statusLabel = (status: VoicemailMatrixRow['status']): string => {
  if (status === 'auto-allowed') return 'Auto OK';
  if (status === 'manual-only') return 'Manual only';
  return 'Blocked';
};

const statusClass = (status: VoicemailMatrixRow['status']): string => {
  if (status === 'auto-allowed') return 'ok';
  if (status === 'manual-only') return 'warn';
  return 'block';
};

const renderTable = (title: string, rows: VoicemailMatrixRow[]): string => {
  const trs = rows.map((r) => `
    <tr>
      <td><strong>${escapeHtml(r.code)}</strong></td>
      <td>${escapeHtml(r.name)}</td>
      <td class="${statusClass(r.status)}">${escapeHtml(statusLabel(r.status))}</td>
      <td>${escapeHtml(r.agentAction)}</td>
      <td>${escapeHtml(r.statute)}</td>
      <td>${escapeHtml(r.notes)}</td>
    </tr>`).join('');
  return `
    <h2>${escapeHtml(title)}</h2>
    <table>
      <thead>
        <tr>
          <th>Code</th><th>State</th><th>Status</th><th>Agent action</th><th>Statute / basis</th><th>Notes</th>
        </tr>
      </thead>
      <tbody>${trs}</tbody>
    </table>`;
};

export const buildVoicemailMatrixHtml = (generatedAt: string): string => {
  const usRows = buildVoicemailMatrixRows();
  const manualCount = usRows.filter((r) => r.status === 'manual-only').length;
  const autoCount = usRows.filter((r) => r.status === 'auto-allowed').length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Voicemail eligibility matrix — Sobriety Select SDR</title>
  <style>
    @page { margin: 0.55in; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 10px; color: #111; line-height: 1.35; }
    h1 { font-size: 18px; margin: 0 0 6px; }
    h2 { font-size: 13px; margin: 18px 0 8px; page-break-after: avoid; }
    .meta { color: #444; margin-bottom: 12px; }
    .disclaimer { background: #fef3c7; border: 1px solid #f59e0b; padding: 10px; border-radius: 6px;
      margin: 12px 0; font-size: 9.5px; }
    .consent { background: #eff6ff; border: 1px solid #3b82f6; padding: 8px; border-radius: 6px;
      margin: 10px 0; font-size: 9.5px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 8px; }
    th, td { border: 1px solid #cbd5e1; padding: 4px 5px; vertical-align: top; text-align: left; }
    th { background: #f1f5f9; font-size: 9px; }
    td.ok { color: #166534; font-weight: 600; }
    td.warn { color: #b45309; font-weight: 600; }
    td.block { color: #b91c1c; font-weight: 600; }
    .counsel { margin-top: 24px; page-break-inside: avoid; }
    .sig-line { border-bottom: 1px solid #333; height: 28px; margin: 8px 0 16px; }
    .summary { display: flex; gap: 16px; margin: 8px 0; }
    .pill { padding: 4px 10px; border-radius: 12px; font-weight: 600; font-size: 9px; }
    .pill-auto { background: #dcfce7; color: #166534; }
    .pill-manual { background: #ffedd5; color: #9a3412; }
  </style>
</head>
<body>
  <h1>Voicemail eligibility — state-by-state matrix</h1>
  <p class="meta">Sobriety Select SDR agent · version ${escapeHtml(MATRIX_VERSION)} · generated ${escapeHtml(generatedAt)}</p>
  <div class="disclaimer"><strong>Not legal advice.</strong> ${escapeHtml(MATRIX_COUNSEL_DISCLAIMER)}</div>
  <div class="summary">
    <span class="pill pill-auto">${autoCount} US states — automated landline VM OK</span>
    <span class="pill pill-manual">${manualCount} US states — manual VM / live call only</span>
  </div>
  <div class="consent">${escapeHtml(PRIOR_WRITTEN_CONSENT_NOTE)}</div>
  ${renderTable('United States (50 states + DC)', usRows)}
  ${renderTable('Non-US (blocked until country program)', NON_US_MATRIX_ROWS)}
  <div class="counsel">
    <h2>Counsel review sign-off</h2>
    <p>I have reviewed the matrix above for Sobriety Select automated voicemail outreach as of the version date.</p>
    <p><strong>Firm / counsel name:</strong></p>
    <div class="sig-line"></div>
    <p><strong>Signature:</strong></p>
    <div class="sig-line"></div>
    <p><strong>Date:</strong></p>
    <div class="sig-line"></div>
    <p><strong>Notes / state additions or removals:</strong></p>
    <div class="sig-line"></div>
  </div>
</body>
</html>`;
};
