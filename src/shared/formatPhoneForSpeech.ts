// E.164 env values (+15132998805) → national spoken form ((513) 299-8805)
// for ElevenLabs scripts. TWILIO_* and SONIA_PHONE env vars stay E.164.

import { parsePhoneNumberFromString } from 'libphonenumber-js';

export const formatPhoneForSpeech = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  const parsed = parsePhoneNumberFromString(trimmed, 'US');
  if (parsed === undefined || !parsed.isValid()) return trimmed;
  return parsed.formatNational();
};
