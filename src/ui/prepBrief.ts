// Prep-brief router (Prompt 9.4).
//
// Two routes, both behind queueAuth:
//
//   GET /prep-brief/lookup?companyId=...
//     Resolves a HubSpot company → first associated deal and 302s to
//     /prep-brief/{dealId}. The approval-queue card links here so Sonia
//     can open a brief without first looking up the dealId.
//
//   GET /prep-brief/:dealId
//     Runs generatePrepBriefWithLead, then either:
//       - ?send=email  → ships the markdown to BRIEF_RECIPIENT via Gmail
//                        and renders a small confirmation page, or
//       - default      → renders a print-friendly HTML page with the
//                        markdown converted inline (no deps — see
//                        renderMarkdown below).
//
// Auth: cookie-based per Security Prompt S.1 — queueAuth refreshes the qpw
// cookie on every successful auth, so a fresh tab opened from the queue
// card works without a ?pw= round trip.
//
// Association API: HubSpot's v3 associationsApi was removed in
// @hubspot/api-client v13.5.0, so we use hs.crm.associations.v4.basicApi
// (same fix Phase 4.3 applied to the company↔contact write path). The
// outreach module does the rest of the v4 fetches.

import express from 'express';
import { hs, hsRetry } from '../shared/hubspot.js';
import { queueAuth } from '../middleware/queueAuth.js';
import { generatePrepBriefWithLead } from '../outreach/prepBrief.js';
import { sendEmail } from '../shared/gmail.js';
import { markdownToDocumentHtml } from '../shared/markdownHtml.js';

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

// Print-friendly styling. Sonia opens this 5 minutes before a call — small
// typography, generous line-height, narrow column. Print rules strip the
// fixed max-width so a paper printout uses the full page.
const BRIEF_PAGE_CSS = `
  :root { color-scheme: light; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111; background: #fafafa; margin: 0; padding: 32px 16px; }
  .brief { max-width: 760px; margin: 0 auto; background: #ffffff; padding: 32px 40px; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); line-height: 1.55; font-size: 15px; }
  .brief h1, .brief h2, .brief h3 { line-height: 1.25; margin: 24px 0 8px; }
  .brief h1 { font-size: 22px; }
  .brief h2 { font-size: 18px; border-bottom: 1px solid #eee; padding-bottom: 4px; }
  .brief h3 { font-size: 16px; }
  .brief p { margin: 8px 0; }
  .brief ul, .brief ol { margin: 8px 0 12px; padding-left: 24px; }
  .brief li { margin: 4px 0; }
  .brief code { background: #f4f4f5; padding: 1px 4px; border-radius: 3px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .brief blockquote { border-left: 3px solid #ddd; margin: 8px 0; padding: 4px 12px; color: #555; }
  .brief strong { font-weight: 600; }
  .meta { max-width: 760px; margin: 0 auto 16px; display: flex; justify-content: space-between; align-items: center; color: #6b7280; font-size: 12px; }
  .meta a { color: #2563eb; text-decoration: none; }
  .meta a:hover { text-decoration: underline; }
  @media print {
    body { background: #ffffff; padding: 0; }
    .meta { display: none; }
    .brief { box-shadow: none; border-radius: 0; max-width: none; padding: 0; }
  }
`;

const renderBriefPage = (
  dealId: string,
  leadName: string,
  markdown: string,
): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Prep brief: ${escapeHtml(leadName)}</title>
<style>${BRIEF_PAGE_CSS}</style>
</head>
<body>
  <div class="meta">
    <span>Deal ${escapeHtml(dealId)}</span>
    <span><a href="?send=email">📧 Email to me</a> &middot; <a href="javascript:window.print()">🖨 Print</a></span>
  </div>
  <article class="brief">${markdownToDocumentHtml(markdown)}</article>
</body>
</html>`;

const renderEmailSent = (
  recipient: string,
  leadName: string,
): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Prep brief sent</title>
</head>
<body style="${PAGE_STYLE}">
  <h1 style="font-size:18px;margin:0 0 12px;">📧 Prep brief sent.</h1>
  <p style="color:#374151;font-size:14px;line-height:1.6;">
    Delivered to <strong>${escapeHtml(recipient)}</strong> for <strong>${escapeHtml(leadName)}</strong>.
  </p>
  <p style="margin-top:24px;font-size:13px;">
    <a href="?" style="color:#2563eb;text-decoration:none;">← View brief in browser</a>
  </p>
</body>
</html>`;

const renderError = (title: string, detail: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(title)}</title>
</head>
<body style="${PAGE_STYLE}">
  <h1 style="font-size:18px;margin:0 0 12px;">${escapeHtml(title)}</h1>
  <p style="color:#374151;font-size:14px;line-height:1.5;">${escapeHtml(detail)}</p>
</body>
</html>`;

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

prepBriefRouter.get('/prep-brief/:dealId', queueAuth, async (req, res) => {
  // Express 5 types route params as `string | string[]` to accommodate the
  // optional repeating-segment syntax. Our route uses a single segment, so
  // we narrow defensively and reject anything that arrives as an array.
  const rawDealId = req.params.dealId;
  const dealId = typeof rawDealId === 'string' ? rawDealId.trim() : '';
  if (dealId === '') {
    res.status(400).type('html').send(renderError('Missing dealId', 'Provide a HubSpot deal id in the URL.'));
    return;
  }
  let result;
  try {
    result = await generatePrepBriefWithLead(dealId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(500).type('html').send(renderError('Could not generate prep brief', detail));
    return;
  }
  const { markdown, leadName } = result;

  if (req.query.send === 'email') {
    const recipient = process.env.BRIEF_RECIPIENT ?? '';
    if (recipient === '') {
      res
        .status(500)
        .type('html')
        .send(renderError('BRIEF_RECIPIENT is not set', 'Set BRIEF_RECIPIENT in the environment to enable email delivery.'));
      return;
    }
    await sendEmail({
      to: recipient,
      subject: `Prep brief: ${leadName}`,
      body: markdown,
      bodyFormat: 'markdown',
    });
    res.type('html').send(renderEmailSent(recipient, leadName));
    return;
  }

  res.type('html').send(renderBriefPage(dealId, leadName, markdown));
});
