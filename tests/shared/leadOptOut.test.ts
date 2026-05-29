import { describe, expect, it } from 'vitest';
import { isOptOutReplyText } from '../../src/shared/leadOptOut.js';

describe('isOptOutReplyText', () => {
  it('matches plain stop', () => {
    expect(isOptOutReplyText('stop')).toBe(true);
    expect(isOptOutReplyText('Stop.')).toBe(true);
  });

  it('matches unsubscribe and opt out variants', () => {
    expect(isOptOutReplyText('unsubscribe')).toBe(true);
    expect(isOptOutReplyText('opt out')).toBe(true);
    expect(isOptOutReplyText('opt-out')).toBe(true);
    expect(isOptOutReplyText('remove me')).toBe(true);
  });

  it('rejects normal replies', () => {
    expect(isOptOutReplyText('Thanks — can we talk Tuesday?')).toBe(false);
    expect(isOptOutReplyText('Please stop by our office next week for a tour')).toBe(false);
  });

  it('rejects long messages even if they contain stop', () => {
    expect(isOptOutReplyText(`stop ${'x'.repeat(100)}`)).toBe(false);
  });
});
