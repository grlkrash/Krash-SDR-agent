// PEWC opt-in block appended to renewal / reactivation emails for clients
// with an active deal relationship. Click-through sets Lead.priorWrittenConsent.

import { signPhoneConsentToken } from './phoneConsentToken.js';

const requirePublicUrl = (): string => {
  const raw = process.env.PUBLIC_URL?.trim() ?? '';
  if (raw === '') throw new Error('PUBLIC_URL is not set');
  return raw.replace(/\/+$/, '');
};

export const buildPhoneConsentUrl = (leadId: string): string =>
  `${requirePublicUrl()}/consent-phone?token=${signPhoneConsentToken(leadId)}`;

export const appendPhoneConsentOffer = (body: string, leadId: string): string => {
  const url = buildPhoneConsentUrl(leadId);
  return `${body.trim()}\n\n---\nOptional — phone reminders: If you'd like account or renewal reminders by automated phone or voicemail at your facility line on file, opt in here: ${url}\nYou can opt out anytime by calling us or replying stop to this email.`;
};
