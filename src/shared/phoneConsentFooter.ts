// PEWC opt-in block appended to renewal / reactivation emails for clients
// with an active deal relationship. Click-through sets Lead.priorWrittenConsent.

import { isHtmlBody, plainTextToHtmlFragment } from './emailHtml.js';
import { signPhoneConsentToken } from './phoneConsentToken.js';

const requirePublicUrl = (): string => {
  const raw = process.env.PUBLIC_URL?.trim() ?? '';
  if (raw === '') throw new Error('PUBLIC_URL is not set');
  return raw.replace(/\/+$/, '');
};

export const buildPhoneConsentUrl = (leadId: string): string =>
  `${requirePublicUrl()}/consent-phone?token=${signPhoneConsentToken(leadId)}`;

const PLAIN_CONSENT_BLOCK = (url: string): string =>
  `\n\n---\nOptional — phone reminders: If you'd like account or renewal reminders by automated phone or voicemail at your facility line on file, opt in here: ${url}\nYou can opt out anytime by calling us or replying stop to this email.`;

const HTML_CONSENT_BLOCK = (url: string): string => {
  const href = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return [
    '<br><br>',
    '<hr style="border:none;border-top:1px solid #e5e5e5;margin:20px 0;">',
    '<p style="font-size:13px;line-height:1.5;color:#666666;margin:0;">',
    'Optional — phone reminders: If you&#39;d like account or renewal reminders by automated phone or voicemail at your facility line on file, ',
    `<a href="${href}" style="color:#2563eb;text-decoration:underline;">opt in here</a>.<br>`,
    'You can opt out anytime by calling us or replying stop to this email.',
    '</p>',
  ].join('');
};

export const appendPhoneConsentOffer = (body: string, leadId: string): string => {
  const url = buildPhoneConsentUrl(leadId);
  const trimmed = body.trim();
  // HTML footer so /queue preview and Gmail HTML part show "opt in here" as a link.
  const htmlBody = isHtmlBody(trimmed) ? trimmed : plainTextToHtmlFragment(trimmed);
  return `${htmlBody}${HTML_CONSENT_BLOCK(url)}`;
};

/** Plain-text consent block — used when exporting or deriving text/plain from HTML. */
export const plainPhoneConsentBlock = (leadId: string): string =>
  PLAIN_CONSENT_BLOCK(buildPhoneConsentUrl(leadId));
