// TCPA / FCC AI-voice compliance helpers for automated voicemail drops.
//
// FCC Feb 2024 ruling: AI-generated voices are "artificial" under the TCPA.
// Disclosures and opt-out language are injected deterministically here — not
// left to the LLM — so every rendered MP3 meets the same legal bar.
//
// Counsel must still sign off on the full workflow (consent basis, state
// matrix, DNC scrub). See kb/compliance/can-spam-tcpa.md.

export type VoicemailTouch = 1 | 2;

export type VoicemailTrigger = 'renewal' | 'reactivation';

export type WrapVoicemailScriptOpts = {
  callbackPhoneSpeech: string;
  touch: VoicemailTouch;
  trigger: VoicemailTrigger;
};

export const wrapVoicemailScript = (
  personalizedMiddle: string,
  opts: WrapVoicemailScriptOpts,
): string => {
  const phone = opts.callbackPhoneSpeech.trim();
  const touchLead =
    opts.trigger === 'renewal'
      ? 'Following up on your renewal reminder email. '
      : 'Following up on our reactivation email. ';
  const prefix =
    'This is an automated, pre-recorded message from Sobriety Select, '
    + 'a treatment center directory, using an artificial voice. '
    + 'This is a sales call. '
    + touchLead;
  const suffix =
    phone === ''
      ? ' To opt out of future calls, reply stop to our email.'
      : ` To opt out of future calls, call ${phone}, or reply stop to our email. `
        + `Again, ${phone}.`;
  const middle = personalizedMiddle.trim().replace(/\s+/g, ' ');
  return `${prefix}${middle}${suffix}`.replace(/\s+/g, ' ').trim();
};
