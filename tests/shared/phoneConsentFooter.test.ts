import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendPhoneConsentOffer,
  appendPostSalePhoneFooter,
  hasPostSalePhoneFooter,
} from '../../src/shared/phoneConsentFooter.js';

describe('appendPostSalePhoneFooter', () => {
  const leadId = 'lead_test123';

  beforeEach(() => {
    process.env.PUBLIC_URL = 'https://ssa.example.com';
    process.env.UNSUBSCRIBE_SECRET = 'test-secret';
    process.env.SONIA_PHONE = '+15135551234';
  });

  afterEach(() => {
    delete process.env.PUBLIC_URL;
    delete process.env.UNSUBSCRIBE_SECRET;
    delete process.env.SONIA_PHONE;
  });

  it('wraps plain body in HTML and links opt-in text when not yet consented', () => {
    const out = appendPostSalePhoneFooter('Hello there.', leadId, { priorWrittenConsent: false });
    expect(out).toContain('Hello there.');
    expect(out).toContain('<a href="https://ssa.example.com/consent-phone?token=');
    expect(out).toContain('opt in here</a>');
    expect(out).toContain('opt out of future calls');
    expect(out).not.toContain('opt in here: https://');
    expect(hasPostSalePhoneFooter(out)).toBe(true);
  });

  it('appends opt-out-only footer when consent already on file', () => {
    const out = appendPostSalePhoneFooter('Hello there.', leadId, { priorWrittenConsent: true });
    expect(out).toContain('Phone reminders:');
    expect(out).toContain('opt out of future calls');
    expect(out).not.toContain('opt in here');
    expect(out).not.toContain('consent-phone');
  });

  it('does not double-append when footer already present', () => {
    const once = appendPostSalePhoneFooter('Hi.', leadId, { priorWrittenConsent: false });
    const twice = appendPostSalePhoneFooter(once, leadId, { priorWrittenConsent: false });
    expect(twice.match(/opt in here/g)?.length).toBe(1);
  });

  it('appendPhoneConsentOffer alias keeps opt-in path', () => {
    const out = appendPhoneConsentOffer('<p>Hi <b>team</b></p>', leadId);
    expect(out).toContain('<p>Hi <b>team</b></p>');
    expect(out).toContain('opt in here</a>');
  });
});
