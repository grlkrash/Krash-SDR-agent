import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { signUnsubToken } from './unsubscribeToken.js';

// Sobriety Select is a registered DBA — per legal requirement, customer-facing
// surfaces (footer, branding, From line) must use the DBA only, never the
// parent LLC name.
const COMPANY_NAME = 'Sobriety Select';
const COMPANY_ADDRESS = '105 Maxess Road, Suite 124, Melville, NY 11747';
const UNSUB_MAILTO = 'mailto:unsubscribe@sobrietyselect.com';
const MESSAGE_ID_DOMAIN = 'sobrietyselect.com';

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
};

/** True when Gmail OAuth env is present — email sends and reply polling only. */
export const hasGmailCredentials = (): boolean => {
  const id = process.env.GMAIL_CLIENT_ID?.trim() ?? '';
  const secret = process.env.GMAIL_CLIENT_SECRET?.trim() ?? '';
  const refresh = process.env.GMAIL_REFRESH_TOKEN?.trim() ?? '';
  return id !== '' && secret !== '' && refresh !== '';
};

const buildOAuthClient = (): OAuth2Client => {
  const client = new google.auth.OAuth2({
    clientId: requireEnv('GMAIL_CLIENT_ID'),
    clientSecret: requireEnv('GMAIL_CLIENT_SECRET'),
  });
  client.setCredentials({ refresh_token: requireEnv('GMAIL_REFRESH_TOKEN') });
  return client;
};

// Per RFC 2047 — encode non-ASCII subjects as a UTF-8 base64 encoded-word so
// Gmail and downstream MTAs don't mangle them. ASCII passes through unchanged.
const encodeHeaderValue = (value: string): string => {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
};

const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const plainTextToHtml = (body: string): string =>
  escapeHtml(body).replace(/\r\n/g, '\n').replace(/\n/g, '<br>\n');

const encodeBase64Body = (text: string): string =>
  Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');

const buildUnsubUrl = (to: string): string => {
  const publicUrl = requireEnv('PUBLIC_URL').replace(/\/+$/, '');
  return `${publicUrl}/unsubscribe?token=${signUnsubToken(to)}`;
};

// Inline styles only — external CSS is stripped by most clients.
const buildHtmlFooter = (unsubUrl: string): string => {
  const href = encodeURI(unsubUrl);
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"',
    ' style="margin-top:28px;border-top:1px solid #e5e5e5;">',
    '<tr><td align="center" style="padding:16px 12px 8px;',
    'font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.5;color:#666666;">',
    `<strong style="color:#333333;font-weight:700;">${escapeHtml(COMPANY_NAME)}</strong><br>`,
    `${escapeHtml(COMPANY_ADDRESS)}`,
    '</td></tr>',
    '<tr><td align="center" style="padding:0 12px 12px;',
    'font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.4;">',
    `<a href="${href}" style="color:#888888;text-decoration:underline;">Unsubscribe</a>`,
    '</td></tr></table>',
  ].join('');
};

const buildPlainFooter = (unsubUrl: string): string =>
  [
    '',
    '---',
    COMPANY_NAME,
    COMPANY_ADDRESS,
    '',
    `Unsubscribe: ${unsubUrl}`,
  ].join('\n');

type EmailBodies = { plain: string; html: string; unsubUrl: string };

const buildBodies = (opts: { to: string; body: string }): EmailBodies => {
  const unsubUrl = buildUnsubUrl(opts.to);
  return {
    plain: `${opts.body}${buildPlainFooter(unsubUrl)}`,
    html: [
      '<!DOCTYPE html><html><body style="margin:0;padding:0;">',
      `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;">`,
      plainTextToHtml(opts.body),
      '</div>',
      buildHtmlFooter(unsubUrl),
      '</body></html>',
    ].join(''),
    unsubUrl,
  };
};

const buildMimePart = (contentType: string, body: string, boundary: string): string =>
  [
    `--${boundary}`,
    `${contentType}; charset="UTF-8"`,
    'Content-Transfer-Encoding: base64',
    '',
    encodeBase64Body(body),
  ].join('\r\n');

const buildRaw = (opts: {
  from: string;
  to: string;
  subject: string;
  plainBody: string;
  htmlBody: string;
  messageId: string;
  unsubUrl: string;
  inReplyTo?: string;
  references?: string;
}): string => {
  const boundary = `----=_Part_${randomUUID()}`;
  const headers: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeaderValue(opts.subject)}`,
    `Message-ID: <${opts.messageId}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    `List-Unsubscribe: <${opts.unsubUrl}>, <${UNSUB_MAILTO}>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  ];
  if (opts.inReplyTo !== undefined && opts.inReplyTo !== '') {
    const ref = opts.references ?? opts.inReplyTo;
    headers.push(`In-Reply-To: <${opts.inReplyTo}>`);
    headers.push(`References: <${ref}>`);
  }
  const parts = [
    buildMimePart('Content-Type: text/plain', opts.plainBody, boundary),
    buildMimePart('Content-Type: text/html', opts.htmlBody, boundary),
    `--${boundary}--`,
  ].join('\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${parts}\r\n`;
};

export const sendEmail = async (opts: {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): Promise<string> => {
  const from = requireEnv('GMAIL_FROM');
  const { plain, html, unsubUrl } = buildBodies({ to: opts.to, body: opts.body });
  // Self-generated Message-ID so we can return it immediately and downstream
  // reply matching can compare it against parsed In-Reply-To / References.
  const messageId = `${randomUUID()}@${MESSAGE_ID_DOMAIN}`;

  const rawMessage = buildRaw({
    from,
    to: opts.to,
    subject: opts.subject,
    plainBody: plain,
    htmlBody: html,
    messageId,
    unsubUrl,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
  });
  const raw = Buffer.from(rawMessage, 'utf8').toString('base64url');

  const gmail = google.gmail({ version: 'v1', auth: buildOAuthClient() });
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return messageId;
};
