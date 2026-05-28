import { describe, expect, it } from 'vitest';
import { formatPhoneForSpeech } from '../../src/shared/formatPhoneForSpeech.js';

describe('formatPhoneForSpeech', () => {
  it('formats E.164 US to national spoken form', () => {
    expect(formatPhoneForSpeech('+15132998805')).toBe('(513) 299-8805');
  });

  it('strips leading +1 from env-style values with spaces', () => {
    expect(formatPhoneForSpeech('+1 513 813 4942')).toBe('(513) 813-4942');
  });

  it('passes through invalid input unchanged', () => {
    expect(formatPhoneForSpeech('not-a-phone')).toBe('not-a-phone');
  });
});
