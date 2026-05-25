import express from 'express';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { verifyUnsubToken } from '../shared/unsubscribeToken.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    if (c === '&') return '&amp;';
    if (c === '<') return '&lt;';
    if (c === '>') return '&gt;';
    if (c === '"') return '&quot;';
    return '&#39;';
  });

const PAGE_STYLE =
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:80px auto;padding:24px;text-align:center;color:#111;";

const renderConfirmation = (email: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Unsubscribed</title>
</head>
<body style="${PAGE_STYLE}">
  <h1 style="font-size:20px;margin:0 0 12px;">You've been unsubscribed.</h1>
  <p style="color:#374151;font-size:15px;line-height:1.5;">
    We won't email <strong>${escapeHtml(email)}</strong> again.
  </p>
</body>
</html>`;

const renderError = (): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Invalid link</title>
</head>
<body style="${PAGE_STYLE}">
  <h1 style="font-size:20px;margin:0 0 12px;">Invalid or expired link.</h1>
  <p style="color:#374151;font-size:15px;line-height:1.5;">
    Please reply to one of our emails and we'll remove you manually.
  </p>
</body>
</html>`;

export const unsubscribeRouter = express.Router();

unsubscribeRouter.get('/unsubscribe', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (token === '') {
    res.status(400).type('html').send(renderError());
    return;
  }
  const payload = verifyUnsubToken(token);
  if (payload === null) {
    res.status(400).type('html').send(renderError());
    return;
  }
  const email = payload.email.toLowerCase();
  await prisma.suppression.upsert({
    where: { email_phoneE164: { email, phoneE164: '' } },
    create: { email, phoneE164: '', reason: 'opt-out' },
    update: { reason: 'opt-out' },
  });
  await prisma.auditLog.create({
    data: {
      action: 'unsubscribe',
      entity: 'suppression',
      entityId: email,
      meta: { source: 'link' },
    },
  });
  res.type('html').send(renderConfirmation(email));
});
