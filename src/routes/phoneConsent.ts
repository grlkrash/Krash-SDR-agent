import express from 'express';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { verifyPhoneConsentToken } from '../shared/phoneConsentToken.js';

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
  "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:560px;margin:80px auto;padding:24px;color:#111;";

const renderConfirmation = (facility: string): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Phone opt-in confirmed</title></head>
<body style="${PAGE_STYLE}">
  <h1 style="font-size:20px;margin:0 0 12px;">You're opted in.</h1>
  <p style="color:#374151;font-size:15px;line-height:1.5;">
    <strong>${escapeHtml(facility)}</strong> may receive automated or pre-recorded account
    and renewal reminders by phone or voicemail at the number we have on file.
  </p>
  <p style="color:#374151;font-size:14px;line-height:1.5;">
    To opt out later, call us or reply stop to any Sobriety Select email.
  </p>
</body></html>`;

const renderError = (): string => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Invalid link</title></head>
<body style="${PAGE_STYLE}">
  <h1 style="font-size:20px;">Invalid or expired link.</h1>
  <p style="color:#374151;">Reply to your Sobriety Select contact and we'll help manually.</p>
</body></html>`;

export const phoneConsentRouter = express.Router();

phoneConsentRouter.get('/consent-phone', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (token === '') {
    res.status(400).type('html').send(renderError());
    return;
  }
  const payload = verifyPhoneConsentToken(token);
  if (payload === null) {
    res.status(400).type('html').send(renderError());
    return;
  }

  const lead = await prisma.lead.findUnique({
    where: { id: payload.leadId },
    select: { id: true, name: true, priorWrittenConsent: true },
  });
  if (lead === null) {
    res.status(404).type('html').send(renderError());
    return;
  }

  const now = new Date();
  if (!lead.priorWrittenConsent) {
    await prisma.lead.update({
      where: { id: lead.id },
      data: { priorWrittenConsent: true, priorWrittenConsentAt: now },
    });
    await prisma.auditLog.create({
      data: {
        action: 'lead.prior-written-consent',
        entity: 'Lead',
        entityId: lead.id,
        meta: { source: 'email-link', grantedAt: now.toISOString() },
      },
    });
  }

  res.type('html').send(renderConfirmation(lead.name));
});
