// Voicemail eligibility gate — checks country + state before any paid API
// call (Twilio Lookups, Claude, ElevenLabs).
//
// Federal TCPA permits prerecorded calls to BUSINESS landlines (the
// residential-line prohibition in 47 USC § 227(b)(1)(B) doesn't reach
// businesses, and our Twilio Lookups filter already excludes mobile/VoIP).
// Several states layer their own restrictions on top — the matrix below
// is best-faith analysis of US state statutes as of mid-2026 and MUST be
// validated by counsel before any state is added or removed.
//
// Anything non-US is blocked outright until a per-country consent program
// (REPEP scrub for MX, CRTC compliance for CA, etc.) is in place.

import { parsePhoneNumberFromString } from 'libphonenumber-js';

export type EligibilityResult =
  | { allowed: true }
  | { allowed: false; reason: string };

// US states where automated voicemail drops to landlines are blocked.
// Each entry cites the controlling statute. Add or remove only after
// counsel review.
//
// FL — Fla. Stat. § 501.059 (FTSA, am. 2023 HB 761): prior express written
//      consent required for any telephonic sales call using "an automated
//      system for the selection or dialing of telephone numbers or the
//      playing of a recorded message." Private right of action; $500
//      statutory damages, $1,500 trebled willful. 2023 amendment added a
//      15-day cure-notice but the consent rule stands.
// OK — 15 Okla. Stat. § 775C.1 (OTSA, eff. Nov 2022): modeled on FTSA
//      pre-2023; prior express written consent required.
// WA — RCW 80.36.400 + RCW 19.190: restricts use of automatic dialing and
//      announcing devices (ADAD) for commercial solicitation; consent or
//      established business relationship required.
// IN — IC 24-5-14 (Indiana Telephone Privacy Act): prerecorded message
//      restrictions, narrow exemptions.
// MA — 940 CMR 19: telemarketing registration requirement + restrictions
//      on artificial voice messages.
export const MANUAL_ONLY_US_STATES = new Set<string>([
  'FL',
  'OK',
  'WA',
  'IN',
  'MA',
]);

export const isAutoVoicemailAllowed = (
  phoneE164: string,
  state: string | null,
  priorWrittenConsent = false,
): EligibilityResult => {
  const parsed = parsePhoneNumberFromString(phoneE164);
  const country = parsed?.country ?? null;
  if (country === null) return { allowed: false, reason: 'unknown-country' };
  if (country !== 'US') return { allowed: false, reason: `non-us-country:${country}` };

  const normalizedState = state?.toUpperCase().trim() ?? '';
  if (normalizedState === '') return { allowed: false, reason: 'unknown-state' };
  if (MANUAL_ONLY_US_STATES.has(normalizedState)) {
    if (priorWrittenConsent) return { allowed: true };
    return { allowed: false, reason: `state-law-restricted:${normalizedState}` };
  }
  return { allowed: true };
};
