import { describe, expect, it } from 'vitest';
import { isAutoVoicemailAllowed } from '../../src/shared/voicemailEligibility.js';

describe('isAutoVoicemailAllowed', () => {
  it('blocks FL without consent', () => {
    const r = isAutoVoicemailAllowed('+13055551234', 'FL', false);
    expect(r).toEqual({ allowed: false, reason: 'state-law-restricted:FL' });
  });

  it('allows FL with prior written consent', () => {
    const r = isAutoVoicemailAllowed('+13055551234', 'FL', true);
    expect(r).toEqual({ allowed: true });
  });

  it('allows NY without consent', () => {
    const r = isAutoVoicemailAllowed('+12125551234', 'NY', false);
    expect(r).toEqual({ allowed: true });
  });

  it('blocks Mexico regardless of consent', () => {
    const r = isAutoVoicemailAllowed('+525512345678', 'FL', true);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.reason).toMatch(/^non-us-country:/);
  });
});
