import { describe, expect, it } from 'vitest';
import { normalizeUsState } from '../../src/pipeline/exclusions/parseScrapedLabel.js';

describe('normalizeUsState', () => {
  it('maps full state names to abbreviations', () => {
    expect(normalizeUsState('Massachusetts')).toBe('MA');
    expect(normalizeUsState('MO')).toBe('MO');
  });
});
