// Twilio client + landline gate for voicemail drops.
//
// `isLandline` is the TCPA gate before any ringless-VM attempt. Twilio Lookups
// v2 with `line_type_intelligence` returns a `type` of 'landline' | 'mobile' |
// 'fixedVoip' | 'nonFixedVoip' | 'personal' | 'tollFree' | 'voicemail' |
// 'unknown'. We allow ONLY 'landline' through — every other value (including
// VoIP which is often routed to a cell) returns false so the caller skips.
//
// The Lookups type field may be absent when Twilio can't classify a number;
// the `?.` keeps that case as a hard `false` rather than a runtime crash.

import Twilio from 'twilio';

const LOOKUP_FIELDS = 'line_type_intelligence';
const LANDLINE = 'landline';

export const twilio = Twilio(
  process.env.TWILIO_ACCOUNT_SID ?? '',
  process.env.TWILIO_AUTH_TOKEN ?? '',
);

export const isLandline = async (phoneE164: string): Promise<boolean> => {
  const r = await twilio.lookups.v2
    .phoneNumbers(phoneE164)
    .fetch({ fields: LOOKUP_FIELDS });
  return r.lineTypeIntelligence?.type === LANDLINE;
};
