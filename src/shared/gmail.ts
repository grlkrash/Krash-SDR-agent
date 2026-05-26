import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { signUnsubToken } from './unsubscribeToken.js';

// Sobriety Select is a registered DBA — per legal requirement, customer-facing
// surfaces (footer, branding, From line) must use the DBA only, never the
// parent LLC name.
const COMPANY_FOOTER_LINE =
  'Sobriety Select, 105 Maxess Road, Suite 124, Melville, NY 11747';
const UNSUB_MAILTO = 'mailto:unsubscribe@sobrietyselect.com';
const MESSAGE_ID_DOMAIN = 'sobrietyselect.com';

const requireEnv = (name: string): string => {
  const v = process.env[name];
  if (v === undefined || v === '') throw new Error(`${name} is not set`);
  return v;
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

const buildFooter = (to: string): string => {
  const publicUrl = requireEnv('PUBLIC_URL').replace(/\/+$/, '');
  const unsubUrl = `${publicUrl}/unsubscribe?token=${signUnsubToken(to)}`;
  return ['', '---', COMPANY_FOOTER_LINE, `Unsubscribe: ${unsubUrl}`].join('\n');
};

const buildRaw = (opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  unsubUrl: string;
  inReplyTo?: string;
  references?: string;
}): string => {
  const headers: string[] = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${encodeHeaderValue(opts.subject)}`,
    `Message-ID: <${opts.messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    `List-Unsubscribe: <${opts.unsubUrl}>, <${UNSUB_MAILTO}>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
  ];
  if (opts.inReplyTo !== undefined && opts.inReplyTo !== '') {
    const ref = opts.references ?? opts.inReplyTo;
    headers.push(`In-Reply-To: <${opts.inReplyTo}>`);
    headers.push(`References: <${ref}>`);
  }
  // Base64-encode body in 76-char lines per RFC 2045 to safely carry UTF-8.
  const bodyB64 = Buffer.from(opts.body, 'utf8')
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n');
  return [...headers, '', bodyB64].join('\r\n');
};

export const sendEmail = async (opts: {
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): Promise<string> => {
  const from = requireEnv('GMAIL_FROM');
  const publicUrl = requireEnv('PUBLIC_URL').replace(/\/+$/, '');
  const unsubUrl = `${publicUrl}/unsubscribe?token=${signUnsubToken(opts.to)}`;
  // Self-generated Message-ID so we can return it immediately and downstream
  // reply matching can compare it against parsed In-Reply-To / References.
  const messageId = `${randomUUID()}@${MESSAGE_ID_DOMAIN}`;

  const fullBody = `${opts.body}${buildFooter(opts.to)}`;
  const rawMessage = buildRaw({
    from,
    to: opts.to,
    subject: opts.subject,
    body: fullBody,
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
