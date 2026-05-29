import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendPhoneConsentOffer } from '../../src/shared/phoneConsentFooter.js';

describe('appendPhoneConsentOffer', () => {
  const leadId = 'lead_test123';

  beforeEach(() => {
    process.env.PUBLIC_URL = 'https://ssa.example.com';
    process.env.UNSUBSCRIBE_SECRET = 'test-secret';
  });

  afterEach(() => {
    delete process.env.PUBLIC_URL;
    delete process.env.UNSUBSCRIBE_SECRET;
  });

  it('wraps plain body in HTML and links opt-in text', () => {
    const out = appendPhoneConsentOffer('Hello there.', leadId);
    expect(out).toContain('Hello there.');
    expect(out).toContain('<a href="https://ssa.example.com/consent-phone?token=');
    expect(out).toContain('opt in here</a>');
    expect(out).not.toContain('opt in here: https://');
  });

  it('appends HTML consent block when body already has formatting', () => {
    const out = appendPhoneConsentOffer('<p>Hi <b>team</b></p>', leadId);
    expect(out).toContain('<p>Hi <b>team</b></p>');
    expect(out).toContain('opt in here</a>');
  });
});
