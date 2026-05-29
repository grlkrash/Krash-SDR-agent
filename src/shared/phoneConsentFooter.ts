// PEWC opt-in + TCPA opt-out block for renewal / reactivation emails when the
// lead has a facility phone on file. Click-through sets Lead.priorWrittenConsent.

import { isHtmlBody, plainTextToHtmlFragment } from './emailHtml.js';
import { formatPhoneForSpeech } from './formatPhoneForSpeech.js';
import { signPhoneConsentToken } from './phoneConsentToken.js';

const FOOTER_MARKER = 'ssa-phone-footer';

const requirePublicUrl = (): string => {
  const raw = process.env.PUBLIC_URL?.trim() ?? '';
  if (raw === '') throw new Error('PUBLIC_URL is not set');
  return raw.replace(/\/+$/, '');
};

export const buildPhoneConsentUrl = (leadId: string): string =>
  `${requirePublicUrl()}/consent-phone?token=${signPhoneConsentToken(leadId)}`;

const callbackPhoneDisplay = (): string => formatPhoneForSpeech(process.env.SONIA_PHONE ?? '');

const optOutLinePlain = (phone: string): string =>
  phone === ''
    ? 'To opt out of future calls, reply STOP to this email.'
    : `To opt out of future calls, call ${phone} or reply STOP to this email.`;

const optOutLineHtml = (phone: string): string => {
  const line = optOutLinePlain(phone);
  if (phone === '') return line;
  const tel = (process.env.SONIA_PHONE ?? '').trim();
  if (tel === '') return line;
  return line.replace(phone, `<a href="tel:${tel}" style="color:#2563eb;text-decoration:underline;">${phone}</a>`);
};

export const hasPostSalePhoneFooter = (body: string): boolean =>
  body.includes(FOOTER_MARKER) || body.includes('/consent-phone');

const PLAIN_OPT_IN_BLOCK = (url: string, phone: string): string =>
  `\n\n---\nOptional — phone reminders: If you'd like account or renewal reminders by automated phone or voicemail at your facility line on file, opt in here: ${url}\n${optOutLinePlain(phone)}`;

const HTML_OPT_IN_BLOCK = (url: string, phone: string): string => {
  const href = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return [
    '<!-- ssa-phone-footer -->',
    '<br><br>',
    '<hr style="border:none;border-top:1px solid #e5e5e5;margin:20px 0;">',
    '<p style="font-size:13px;line-height:1.5;color:#666666;margin:0;">',
    'Optional — phone reminders: If you&#39;d like account or renewal reminders by automated phone or voicemail at your facility line on file, ',
    `<a href="${href}" style="color:#2563eb;text-decoration:underline;">opt in here</a>.<br>`,
    optOutLineHtml(phone),
    '</p>',
  ].join('');
};

const PLAIN_OPT_OUT_ONLY_BLOCK = (phone: string): string =>
  `\n\n---\nPhone reminders: You may receive automated account or renewal reminders at your facility line on file.\n${optOutLinePlain(phone)}`;

const HTML_OPT_OUT_ONLY_BLOCK = (phone: string): string => [
  '<!-- ssa-phone-footer -->',
  '<br><br>',
  '<hr style="border:none;border-top:1px solid #e5e5e5;margin:20px 0;">',
  '<p style="font-size:13px;line-height:1.5;color:#666666;margin:0;">',
  'Phone reminders: You may receive automated account or renewal reminders at your facility line on file.<br>',
  optOutLineHtml(phone),
  '</p>',
].join('');

export type PostSalePhoneFooterOpts = {
  priorWrittenConsent: boolean;
};

/** Append opt-in (if needed) + opt-out disclosure for post-sale emails with phone on file. */
export const appendPostSalePhoneFooter = (
  body: string,
  leadId: string,
  opts: PostSalePhoneFooterOpts,
): string => {
  if (hasPostSalePhoneFooter(body)) return body;
  const phone = callbackPhoneDisplay();
  const trimmed = body.trim();
  const htmlBody = isHtmlBody(trimmed) ? trimmed : plainTextToHtmlFragment(trimmed);
  if (opts.priorWrittenConsent) {
    return `${htmlBody}${HTML_OPT_OUT_ONLY_BLOCK(phone)}`;
  }
  const url = buildPhoneConsentUrl(leadId);
  return `${htmlBody}${HTML_OPT_IN_BLOCK(url, phone)}`;
};

/** @deprecated Use appendPostSalePhoneFooter — kept for call sites that only need opt-in path. */
export const appendPhoneConsentOffer = (body: string, leadId: string): string =>
  appendPostSalePhoneFooter(body, leadId, { priorWrittenConsent: false });

/** Plain-text consent block — used when exporting or deriving text/plain from HTML. */
export const plainPhoneConsentBlock = (leadId: string): string =>
  PLAIN_OPT_IN_BLOCK(buildPhoneConsentUrl(leadId), callbackPhoneDisplay());
