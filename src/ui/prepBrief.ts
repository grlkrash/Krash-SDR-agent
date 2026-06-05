// Prep-brief router (Prompt 9.4).
//
// Primary route: GET /prep-brief/lead/:leadId — DB-first; auto-creates a
// HubSpot deal when none exists. Legacy routes:
//   GET /prep-brief/lookup?companyId=... → resolves lead, redirects to lead route
//   GET /prep-brief/:dealId → deal-id entry (still supported)

import express from 'express';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { queueAuth } from '../middleware/queueAuth.js';
import { generatePrepBriefForLead, generatePrepBriefWithLead } from '../outreach/prepBrief.js';
import { sendEmail } from '../shared/gmail.js';
import { markdownToDocumentHtml } from '../shared/markdownHtml.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

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

const renderMissingParam = (param: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Missing ${escapeHtml(param)}</title>
</head>
<body style="${PAGE_STYLE}">
  <h1 style="font-size:18px;margin:0 0 12px;">Missing ${escapeHtml(param)}.</h1>
  <p style="color:#374151;font-size:14px;line-height:1.5;">
    Open this page from the approval queue's Prep Brief link.
  </p>
</body>
</html>`;

const renderNoLead = (companyId: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>No synced lead</title>
</head>
<body style="${PAGE_STYLE}">
  <h1 style="font-size:18px;margin:0 0 12px;">No synced lead for this HubSpot company.</h1>
  <p style="color:#374151;font-size:14px;line-height:1.5;">
    Run pipeline enrich + hubspot sync for this facility first.
  </p>
  <p style="color:#9ca3af;font-size:12px;margin-top:24px;">Company ID: ${escapeHtml(companyId)}</p>
</body>
</html>`;

const readQueryString = (req: express.Request, key: string): string | null => {
  const raw = req.query[key];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw.trim();
};

const readRouteParam = (raw: string | string[] | undefined): string => {
  if (typeof raw !== 'string') return '';
  return raw.trim();
};

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
  leadId: string,
  leadName: string,
  dealId: string | null,
  markdown: string,
): string => {
  const dealMeta = dealId === null
    ? `Lead ${escapeHtml(leadId)}`
    : `Deal ${escapeHtml(dealId)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Prep brief: ${escapeHtml(leadName)}</title>
<style>${BRIEF_PAGE_CSS}</style>
</head>
<body>
  <div class="meta">
    <span>${dealMeta}</span>
    <span><a href="?send=email">📧 Email to me</a> &middot; <a href="javascript:window.print()">🖨 Print</a></span>
  </div>
  <article class="brief">${markdownToDocumentHtml(markdown)}</article>
</body>
</html>`;
};

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

const deliverBrief = async (
  req: express.Request,
  res: express.Response,
  generate: () => Promise<{ markdown: string; leadName: string; leadId: string; dealId: string | null }>,
): Promise<void> => {
  let result;
  try {
    result = await generate();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    res.status(500).type('html').send(renderError('Could not generate prep brief', detail));
    return;
  }
  const { markdown, leadName, leadId, dealId } = result;

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

  res.type('html').send(renderBriefPage(leadId, leadName, dealId, markdown));
};

export const prepBriefRouter = express.Router();

prepBriefRouter.get('/prep-brief/lookup', queueAuth, async (req, res) => {
  const companyId = readQueryString(req, 'companyId');
  if (companyId === null) {
    res.status(400).type('html').send(renderMissingParam('companyId'));
    return;
  }
  const lead = await prisma.lead.findFirst({
    where: { hubspotCompanyId: companyId },
    select: { id: true },
  });
  if (lead === null) {
    res.status(404).type('html').send(renderNoLead(companyId));
    return;
  }
  res.redirect(302, `/prep-brief/lead/${encodeURIComponent(lead.id)}`);
});

prepBriefRouter.get('/prep-brief/lead/:leadId', queueAuth, async (req, res) => {
  const leadId = readRouteParam(req.params.leadId);
  if (leadId === '') {
    res.status(400).type('html').send(renderMissingParam('leadId'));
    return;
  }
  await deliverBrief(req, res, () => generatePrepBriefForLead(leadId));
});

prepBriefRouter.get('/prep-brief/:dealId', queueAuth, async (req, res) => {
  const dealId = readRouteParam(req.params.dealId);
  if (dealId === '' || dealId === 'lead' || dealId === 'lookup') {
    res.status(400).type('html').send(renderError('Missing dealId', 'Provide a HubSpot deal id in the URL.'));
    return;
  }
  await deliverBrief(req, res, () => generatePrepBriefWithLead(dealId));
});
