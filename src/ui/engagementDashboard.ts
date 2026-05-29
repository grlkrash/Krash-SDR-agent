// Server-rendered engagement dashboard fragments for /queue.

import type {
  EngagementOverview,
  EngagementRange,
  LeadEngagementSummary,
  LeadTemperatureBadge,
} from '../outreach/emailEngagementStats.js';
import { formatRate } from '../outreach/emailEngagementStats.js';

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });

const TEMPERATURE_CLASS: Record<LeadTemperatureBadge['temperature'], string> = {
  hot: 'temp-hot',
  warm: 'temp-warm',
  cool: 'temp-cool',
  cold: 'temp-cold',
};

export const ENGAGEMENT_DASHBOARD_STYLE = `
  .engagement-dash { background: white; border: 1px solid #e5e7eb; border-radius: 10px;
    padding: 14px 16px; margin: 0 0 16px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
  .engagement-dash h2 { font-size: 14px; font-weight: 600; margin: 0 0 10px; color: #374151; }
  .engagement-metrics { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 8px; }
  .engagement-metric { flex: 1 1 120px; min-width: 100px; background: #f8fafc; border: 1px solid #e2e8f0;
    border-radius: 8px; padding: 10px 12px; }
  .engagement-metric .val { font-size: 22px; font-weight: 700; color: #0f172a; line-height: 1.1; }
  .engagement-metric .lbl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    color: #64748b; margin-top: 4px; font-weight: 600; }
  .engagement-note { font-size: 11px; color: #94a3b8; margin: 0 0 8px; line-height: 1.4; }
  .engagement-details { margin-top: 4px; }
  .engagement-details summary { cursor: pointer; font-size: 13px; font-weight: 600; color: #2563eb;
    user-select: none; padding: 4px 0; }
  .engagement-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  .engagement-table th, .engagement-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #f1f5f9; }
  .engagement-table th { color: #64748b; font-weight: 600; font-size: 11px; text-transform: uppercase; }
  .engagement-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .temp-badge { display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 10px;
    font-weight: 600; text-decoration: none; margin-left: 8px; vertical-align: middle; }
  .temp-badge:hover { text-decoration: none; opacity: 0.9; }
  .temp-hot { background: #fee2e2; color: #991b1b; }
  .temp-warm { background: #ffedd5; color: #9a3412; }
  .temp-cool { background: #e0f2fe; color: #075985; }
  .temp-cold { background: #f1f5f9; color: #475569; }
  .lead-engagement-page { max-width: 680px; }
  .lead-engagement-page h1 { font-size: 20px; margin-bottom: 4px; }
  .lead-engagement-meta { color: #6b7280; font-size: 13px; margin-bottom: 16px; }
  .approach-hint { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px;
    padding: 12px 14px; font-size: 14px; line-height: 1.5; color: #1e3a8a; margin: 16px 0; }
  .back-link { display: inline-block; margin-bottom: 16px; font-size: 14px; }
  .engagement-yes { color: #16a34a; font-weight: 600; }
  .engagement-no { color: #94a3b8; }
  .engagement-range-filters { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
  .engagement-range-pill { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid #d4d4d8;
    background: white; color: #374151; text-decoration: none; font-weight: 500; }
  .engagement-range-pill.active { background: #1e40af; color: white; border-color: #1e40af; }
`;

const ENGAGEMENT_RANGES: Array<{ id: EngagementRange; label: string }> = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '60d', label: '60 days' },
  { id: '90d', label: '90 days' },
  { id: 'all', label: 'All time' },
];

export const renderEngagementRangeFilters = (opts: {
  range: EngagementRange;
  sortMode: 'newest' | 'value';
  laneMode: string;
}): string => {
  const items = ENGAGEMENT_RANGES.map((r) => {
    const qs = new URLSearchParams();
    if (r.id !== 'all') qs.set('period', r.id);
    if (opts.laneMode !== 'all') qs.set('lane', opts.laneMode);
    if (opts.sortMode === 'value') qs.set('sort', 'value');
    const href = qs.size === 0 ? '/queue' : `/queue?${qs.toString()}`;
    const active = r.id === opts.range ? ' active' : '';
    return `<a class="engagement-range-pill${active}" href="${href}">${escapeHtml(r.label)}</a>`;
  }).join('');
  return `<div class="engagement-range-filters" role="toolbar" aria-label="Engagement time range">${items}</div>`;
};

export const renderEngagementDashboard = (overview: EngagementOverview): string => {
  const bucketRows = overview.byBucket.map((row) => `
    <tr>
      <td>${escapeHtml(row.label)}</td>
      <td class="num">${String(row.sent)}</td>
      <td class="num">${formatRate(row.openRate)}</td>
      <td class="num">${formatRate(row.replyRate)}</td>
    </tr>`).join('');

  const bucketTable = overview.byBucket.length === 0
    ? `<p class="engagement-note">No sent emails in ${escapeHtml(overview.rangeLabel.toLowerCase())}.</p>`
    : `<table class="engagement-table">
        <thead><tr>
          <th>Type</th><th>Sent</th><th>Open</th><th>Reply</th>
        </tr></thead>
        <tbody>${bucketRows}</tbody>
      </table>`;

  return `
  <section class="engagement-dash" aria-label="Email engagement rates">
    <h2>📊 Email engagement · ${escapeHtml(overview.rangeLabel)}</h2>
    <div class="engagement-metrics">
      <div class="engagement-metric">
        <div class="val">${formatRate(overview.openRate)}</div>
        <div class="lbl">Avg open rate</div>
      </div>
      <div class="engagement-metric">
        <div class="val">${formatRate(overview.replyRate)}</div>
        <div class="lbl">Avg reply rate</div>
      </div>
      <div class="engagement-metric">
        <div class="val">${String(overview.totals.sent)}</div>
        <div class="lbl">Emails sent</div>
      </div>
    </div>
    <p class="engagement-note">${escapeHtml(overview.openDataNote)}</p>
    <details class="engagement-details">
      <summary>Break down by email type</summary>
      ${bucketTable}
    </details>
  </section>`;
};

export const renderLeadTemperatureBadge = (
  badge: LeadTemperatureBadge | undefined,
): string => {
  if (badge === undefined) return '';
  const cls = TEMPERATURE_CLASS[badge.temperature];
  return `<a class="temp-badge ${cls}" href="${escapeHtml(badge.href)}" title="View engagement for this lead">${escapeHtml(badge.label)}</a>`;
};

const formatSentDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export const renderLeadEngagementPage = (summary: LeadEngagementSummary): string => {
  const backQs = summary.range === 'all' ? '' : `?period=${encodeURIComponent(summary.range)}`;
  const rangeFilters = ENGAGEMENT_RANGES.map((r) => {
    const qs = r.id === 'all' ? '' : `?period=${encodeURIComponent(r.id)}`;
    const href = `/queue/lead-engagement/${encodeURIComponent(summary.leadId)}${qs}`;
    const active = r.id === summary.range ? ' active' : '';
    return `<a class="engagement-range-pill${active}" href="${href}">${escapeHtml(r.label)}</a>`;
  }).join('');

  const emailRows = summary.emails.map((e) => `
    <tr>
      <td>${escapeHtml(e.bucketLabel)}</td>
      <td>${formatSentDate(e.sentAt)}</td>
      <td class="num">${e.opened ? '<span class="engagement-yes">Yes</span>' : '<span class="engagement-no">—</span>'}</td>
      <td class="num">${e.replied ? '<span class="engagement-yes">Yes</span>' : '<span class="engagement-no">—</span>'}</td>
    </tr>`).join('');

  const emailTable = summary.emails.length === 0
    ? `<p class="engagement-note">No sent emails for this lead in ${escapeHtml(summary.rangeLabel.toLowerCase())}.</p>`
    : `<table class="engagement-table">
        <thead><tr>
          <th>Type</th><th>Sent</th><th>Opened</th><th>Replied</th>
        </tr></thead>
        <tbody>${emailRows}</tbody>
      </table>`;

  const tempCls = TEMPERATURE_CLASS[summary.temperature];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(summary.leadName)} — engagement</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 760px; margin: 0 auto; padding: 24px 16px 80px; color: #111; background: #f7f7f8; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  ${ENGAGEMENT_DASHBOARD_STYLE}
</style>
</head>
<body class="lead-engagement-page">
  <a class="back-link" href="/queue${backQs}">← Back to queue</a>
  <h1>${escapeHtml(summary.leadName)}</h1>
  <div class="lead-engagement-meta">${escapeHtml(summary.city)}, ${escapeHtml(summary.state)} · ${escapeHtml(summary.rangeLabel)} · ${String(summary.sent)} sent · ${String(summary.opened)} opened · ${String(summary.replied)} replied</div>
  <div class="engagement-range-filters" role="toolbar" aria-label="Engagement time range">${rangeFilters}</div>
  <span class="temp-badge ${tempCls}">${escapeHtml(summary.temperatureLabel)}</span>
  <div class="approach-hint"><strong>Suggested approach:</strong> ${escapeHtml(summary.approachHint)}</div>
  <section class="engagement-dash">
    <h2>Send history</h2>
    ${emailTable}
  </section>
</body>
</html>`;
};
