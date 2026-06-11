// Ad-hoc facility intel — name or website → scrape + demo prep brief.
// No HubSpot required. GET /intel · POST /intel

import express from 'express';
import type { Enrichment, Lead } from '@prisma/client';
import { queueAuth } from '../middleware/queueAuth.js';
import type { DirectorySearchHit } from '../pipeline/exclusions/fetchDirectoryApi.js';
import {
  IntelInputSchema,
  parseSignals,
  runIntelLookup,
  type IntelLookupResult,
} from '../pipeline/intelLookup.js';
import { markdownToDocumentHtml } from '../shared/markdownHtml.js';

const BRIEF_CSS = `
  .brief { max-width: 760px; margin: 24px auto 0; background: #fff; padding: 28px 36px; border-radius: 8px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08); line-height: 1.55; font-size: 15px; }
  .brief h2 { font-size: 17px; border-bottom: 1px solid #eee; padding-bottom: 4px; margin-top: 20px; }
  .brief ul { padding-left: 22px; }
`;

const PAGE_STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; padding: 24px 16px 48px;
    background: #f8fafc; color: #0f172a; }
  .wrap { max-width: 820px; margin: 0 auto; }
  .nav a { color: #2563eb; text-decoration: none; font-size: 14px; }
  h1 { font-size: 22px; margin: 12px 0 4px; }
  .sub { color: #64748b; font-size: 14px; margin: 0 0 20px; line-height: 1.5; }
  .card { background: #fff; border-radius: 8px; padding: 20px 22px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); margin-bottom: 16px; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  input[type=text], input[type=url] { width: 100%; box-sizing: border-box; padding: 9px 11px; border: 1px solid #d1d5db;
    border-radius: 6px; font-size: 14px; margin-bottom: 14px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .btn { background: #2563eb; color: #fff; border: none; padding: 11px 18px; border-radius: 6px; font-size: 14px;
    font-weight: 600; cursor: pointer; }
  .btn:hover { background: #1d4ed8; }
  .btn:disabled { opacity: 0.65; cursor: wait; }
  .error { color: #b91c1c; font-size: 14px; margin-bottom: 12px; }
  .hint { font-size: 12px; color: #9ca3af; margin: -6px 0 12px; }
  .signals { display: grid; gap: 10px; font-size: 14px; }
  .sig-row { display: flex; gap: 8px; align-items: baseline; }
  .sig-label { min-width: 140px; color: #64748b; font-size: 13px; }
  .sig-val { flex: 1; }
  .pill { display: inline-block; background: #f1f5f9; border-radius: 4px; padding: 2px 8px; font-size: 12px; margin: 2px 4px 2px 0; }
  .pill-yes { background: #dcfce7; color: #166534; }
  .pill-no { background: #fee2e2; color: #991b1b; }
  .meta-links { font-size: 13px; color: #64748b; margin-bottom: 8px; }
  .meta-links a { color: #2563eb; margin-right: 14px; }
  ${BRIEF_CSS}
`;

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });

const tierLabel = (sub: string): string => {
  if (sub === 'subscribe' || sub === 'ads') return 'verified partner';
  if (sub === 'unsubscribe') return 'catalog (free tier)';
  return sub;
};

const renderDirectoryRows = (hits: DirectorySearchHit[]): string => {
  if (hits.length === 0) {
    return '<span class="pill pill-no">No SS directory match</span>';
  }
  return hits.slice(0, 5).map((h) => {
    const loc = [h.city, h.state].filter(Boolean).join(', ');
    const tier = tierLabel(h.subscriptionType);
    const cls = h.subscriptionType === 'subscribe' || h.subscriptionType === 'ads' ? 'pill-yes' : 'pill';
    return `<span class="pill ${cls}">${escapeHtml(h.name)}${loc !== '' ? ` · ${escapeHtml(loc)}` : ''} — ${escapeHtml(tier)}</span>`;
  }).join('');
};

const renderSignalsPanel = (
  lead: Pick<Lead, 'googleRating' | 'googleReviews' | 'website' | 'city' | 'state'>,
  enrichment: Enrichment,
  directoryHits: DirectorySearchHit[],
): string => {
  const signals = parseSignals(enrichment.signals);
  const dirs = signals?.competingDirectories;
  const hiring = signals?.hiring;
  const tech = signals?.techStack;

  const dirText = dirs === undefined
    ? '—'
    : dirs.missingFromAll
      ? '<span class="pill pill-yes">Missing from PT / Rehabs / Recovery.com</span>'
      : '<span class="pill">Listed on competing directory</span>';

  const hireText = hiring === undefined || !hiring.active
    ? '<span class="pill">No active hiring signal</span>'
    : `<span class="pill pill-yes">Hiring · ${escapeHtml(String(hiring.rolesPostedRecently))} roles</span> ${hiring.roleTitles.map((r) => `<span class="pill">${escapeHtml(r)}</span>`).join('')}`;

  const techLabels: Array<[boolean, string]> = tech === undefined ? [] : [
    [tech.hubspot, 'HubSpot'],
    [tech.salesforce, 'Salesforce'],
    [tech.callrail, 'CallRail'],
    [tech.googleAds, 'Google Ads'],
    [tech.facebookPixel, 'FB Pixel'],
    [tech.marketo, 'Marketo'],
  ];
  const techText = techLabels.filter(([on]) => on).length === 0
    ? '<span class="pill">No paid marketing stack detected</span>'
    : `${techLabels.filter(([on]) => on).map(([, l]) => `<span class="pill pill-yes">${escapeHtml(l)}</span>`).join('')} <span class="pill">score ${escapeHtml(String(tech?.bigSpenderScore ?? 0))}/6</span>`;

  const google = lead.googleRating !== null
    ? `${lead.googleRating}★ · ${lead.googleReviews ?? 0} reviews`
    : 'Not on file';

  return `<div class="signals">
    <div class="sig-row"><span class="sig-label">Location</span><span class="sig-val">${escapeHtml(lead.city)}, ${escapeHtml(lead.state)}</span></div>
    <div class="sig-row"><span class="sig-label">Google Places</span><span class="sig-val">${escapeHtml(google)}</span></div>
    <div class="sig-row"><span class="sig-label">SS directory</span><span class="sig-val">${renderDirectoryRows(directoryHits)}</span></div>
    <div class="sig-row"><span class="sig-label">Competing dirs</span><span class="sig-val">${dirText}</span></div>
    <div class="sig-row"><span class="sig-label">Hiring</span><span class="sig-val">${hireText}</span></div>
    <div class="sig-row"><span class="sig-label">Marketing stack</span><span class="sig-val">${techText}</span></div>
    <div class="sig-row"><span class="sig-label">Expected tier</span><span class="sig-val"><span class="pill">${escapeHtml(enrichment.expectedProduct ?? 'unknown')}</span></span></div>
    <div class="sig-row"><span class="sig-label">Website</span><span class="sig-val">${lead.website !== null ? `<a href="${escapeHtml(lead.website)}" target="_blank" rel="noopener">${escapeHtml(lead.website)}</a>` : '—'}</span></div>
  </div>`;
};

type FormState = {
  name: string;
  website: string;
  city: string;
  state: string;
  refresh: boolean;
  error?: string;
  result?: IntelLookupResult;
};

const renderResult = (result: IntelLookupResult): string => `<div class="card">
    <h2 style="font-size:16px;margin:0 0 8px;">${escapeHtml(result.leadName)}</h2>
    ${renderSignalsPanel(
      {
        googleRating: result.googleRating,
        googleReviews: result.googleReviews,
        website: result.website,
        city: result.city,
        state: result.state,
      },
      result.enrichment,
      result.directoryHits,
    )}
  </div>
  <article class="brief">${markdownToDocumentHtml(result.prepBriefMarkdown)}</article>`;

const renderPage = (state: FormState): string => {
  const refreshChecked = state.refresh ? ' checked' : '';
  const resultBlock = state.result !== undefined ? renderResult(state.result) : '';
  const errorBlock = state.error !== undefined ? `<div class="error">${escapeHtml(state.error)}</div>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Demo intel lookup</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<div class="wrap">
  <div class="nav"><a href="/queue">← Approval queue</a> · <a href="/copilot">Sales co-pilot</a></div>
  <h1>Demo intel lookup</h1>
  <p class="sub">Enter a facility name or website from the SS HubSpot (or anywhere). We scrape hiring signals, directory presence, marketing stack, and Google data — then generate a prep brief. No HubSpot connection needed; nothing is written to your CRM.</p>
  ${errorBlock}
  ${resultBlock}
  <div class="card">
    <form method="post" action="/intel" id="intel-form">
      <label for="name">Facility name <span style="font-weight:400;color:#9ca3af">(or leave blank if you have the website)</span></label>
      <input type="text" id="name" name="name" value="${escapeHtml(state.name)}" placeholder="Aspire Recovery Center" />
      <label for="website">Website <span style="font-weight:400;color:#9ca3af">(or leave blank if you have the name)</span></label>
      <input type="text" id="website" name="website" value="${escapeHtml(state.website)}" placeholder="aspirerecovery.com" />
      <div class="row">
        <div>
          <label for="city">City <span style="font-weight:400;color:#9ca3af">(optional — helps Places match)</span></label>
          <input type="text" id="city" name="city" value="${escapeHtml(state.city)}" />
        </div>
        <div>
          <label for="state">State <span style="font-weight:400;color:#9ca3af">(optional)</span></label>
          <input type="text" id="state" name="state" value="${escapeHtml(state.state)}" maxlength="2" placeholder="FL" />
        </div>
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-weight:500;margin:8px 0 16px;">
        <input type="checkbox" name="refresh" value="1"${refreshChecked} />
        Re-scrape signals (uncheck to reuse cached enrichment)
      </label>
      <p class="hint">First visit: add <code>?pw=…</code> (same password as /queue). Takes 30–90 seconds.</p>
      <button type="submit" class="btn" id="submit-btn">Generate prep brief</button>
    </form>
  </div>
</div>
<script>
document.getElementById('intel-form').addEventListener('submit', function () {
  var btn = document.getElementById('submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Scraping & generating brief…'; }
});
</script>
</body>
</html>`;
};

const emptyForm = (): FormState => ({
  name: '',
  website: '',
  city: '',
  state: '',
  refresh: true,
});

const parseFormBody = (body: unknown): FormState & { parsed: ReturnType<typeof IntelInputSchema.safeParse> } => {
  const raw = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  const refresh = raw.refresh === '1' || raw.refresh === true || raw.refresh === 'on';
  const input = {
    name: typeof raw.name === 'string' ? raw.name.trim() : undefined,
    website: typeof raw.website === 'string' ? raw.website.trim() : undefined,
    city: typeof raw.city === 'string' ? raw.city.trim() : undefined,
    state: typeof raw.state === 'string' ? raw.state.trim() : undefined,
    refresh,
  };
  return {
    name: input.name ?? '',
    website: input.website ?? '',
    city: input.city ?? '',
    state: input.state ?? '',
    refresh,
    parsed: IntelInputSchema.safeParse(input),
  };
};

export const intelRouter = express.Router();
intelRouter.use(express.urlencoded({ extended: false }));

intelRouter.get('/intel', queueAuth, (_req, res) => {
  res.type('html').send(renderPage(emptyForm()));
});

intelRouter.post('/intel', queueAuth, async (req, res) => {
  const form = parseFormBody(req.body);
  if (!form.parsed.success) {
    res.type('html').send(renderPage({ ...form, error: 'Invalid form input.' }));
    return;
  }

  const hasName = form.parsed.data.name !== undefined && form.parsed.data.name !== '';
  const hasWebsite = form.parsed.data.website !== undefined && form.parsed.data.website !== '';
  if (!hasName && !hasWebsite) {
    res.type('html').send(renderPage({ ...form, error: 'Enter a facility name or website URL.' }));
    return;
  }

  try {
    const result = await runIntelLookup(form.parsed.data);
    res.type('html').send(renderPage({ ...form, result }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.type('html').send(renderPage({ ...form, error: message }));
  }
});
