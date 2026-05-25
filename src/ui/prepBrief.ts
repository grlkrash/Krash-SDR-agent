// Prep-brief router.
//
// This module currently exposes only GET /prep-brief/lookup, which the
// approval-queue card links to. It resolves a HubSpot company → first
// associated deal and 302s to /prep-brief/{dealId}. The detail route
// (/prep-brief/:dealId) is owned by Prompt 9.4 and will be added here later.
//
// Auth: cookie-based per Security Prompt S.1 — we use queueAuth (the
// cookie-aware middleware) so the link can be opened in a new tab without a
// ?pw= query string. queueAuth still falls back to header/query for tooling.
//
// Association API: HubSpot's v3 associationsApi was removed in
// @hubspot/api-client v13.5.0, so we use hs.crm.associations.v4.basicApi
// (same fix as Phase 4.3 used for the company↔contact write path).

import express from 'express';
import { hs, hsRetry } from '../shared/hubspot.js';
import { queueAuth } from '../middleware/queueAuth.js';

const PAGE_STYLE =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:80px auto;padding:24px;text-align:center;color:#111;";

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });

const renderMissingCompanyId = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Missing companyId</title>
</head>
<body style="${PAGE_STYLE}">
  <h1 style="font-size:18px;margin:0 0 12px;">Missing companyId.</h1>
  <p style="color:#374151;font-size:14px;line-height:1.5;">
    Open this page from the approval queue's Prep Brief link.
  </p>
</body>
</html>`;

const renderNoDeal = (companyId: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>No HubSpot deal</title>
</head>
<body style="${PAGE_STYLE}">
  <h1 style="font-size:18px;margin:0 0 12px;">No HubSpot deal found for this company yet.</h1>
  <p style="color:#374151;font-size:14px;line-height:1.5;">
    Create a deal in HubSpot first, then try again.
  </p>
  <p style="color:#9ca3af;font-size:12px;margin-top:24px;">Company ID: ${escapeHtml(companyId)}</p>
</body>
</html>`;

const readCompanyId = (req: express.Request): string | null => {
  const raw = req.query.companyId;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw.trim();
};

export const prepBriefRouter = express.Router();

prepBriefRouter.get('/prep-brief/lookup', queueAuth, async (req, res) => {
  const companyId = readCompanyId(req);
  if (companyId === null) {
    res.status(400).type('html').send(renderMissingCompanyId());
    return;
  }
  const page = await hsRetry(() =>
    hs.crm.associations.v4.basicApi.getPage('companies', companyId, 'deals'),
  );
  const dealId = page.results[0]?.toObjectId ?? null;
  if (dealId === null) {
    res.status(404).type('html').send(renderNoDeal(companyId));
    return;
  }
  res.redirect(302, `/prep-brief/${encodeURIComponent(dealId)}`);
});
