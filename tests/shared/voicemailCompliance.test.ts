import { describe, expect, it } from 'vitest';
import { wrapVoicemailScript } from '../../src/shared/voicemailCompliance.js';

describe('wrapVoicemailScript', () => {
  const phone = '(513) 299-8805';
  const baseOpts = { callbackPhoneSpeech: phone, touch: 1 as const, trigger: 'renewal' as const };

  it('prepends artificial-voice and sales-call disclosure', () => {
    const script = wrapVoicemailScript('Hey Maria at Acme Recovery in Austin.', baseOpts);
    expect(script).toMatch(/automated, pre-recorded message from Sobriety Select/i);
    expect(script).toMatch(/artificial voice/i);
    expect(script).toMatch(/sales call/i);
  });

  it('uses renewal context in prefix when trigger is renewal', () => {
    const script = wrapVoicemailScript('Quick question about renewal.', baseOpts);
    expect(script).toMatch(/renewal reminder email/i);
  });

  it('uses reactivation context when trigger is reactivation', () => {
    const script = wrapVoicemailScript('Circling back.', {
      ...baseOpts,
      trigger: 'reactivation',
    });
    expect(script).toMatch(/reactivation email/i);
  });

  it('never leaves Sonia speaking-live impersonation to the LLM middle', () => {
    const script = wrapVoicemailScript('Quick question about intake volume.', baseOpts);
    expect(script).not.toMatch(/this is Sonia/i);
  });

  it('appends phone opt-out and email stop instruction', () => {
    const script = wrapVoicemailScript('Call me back when you can.', baseOpts);
    expect(script).toMatch(/opt out of future calls/i);
    expect(script).toMatch(/reply stop to our email/i);
    expect(script).toContain(phone);
  });

  it('falls back to email-only opt-out when phone is empty', () => {
    const script = wrapVoicemailScript('Hey there.', {
      callbackPhoneSpeech: '',
      touch: 1,
      trigger: 'renewal',
    });
    expect(script).toMatch(/reply stop to our email/i);
    expect(script).not.toMatch(/Again,/);
  });
});
