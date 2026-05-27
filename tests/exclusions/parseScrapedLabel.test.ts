import { describe, expect, it } from 'vitest';
import { baseFacilityName, parseScrapedLabel } from '../../src/pipeline/exclusions/parseScrapedLabel.js';

describe('parseScrapedLabel', () => {
  it('parses parenthetical location labels', () => {
    const parsed = parseScrapedLabel(
      'Meta Addiction Treatment (Haverhill)Haverhill, MassachusettsInsurance accepted',
    );
    expect(parsed.name).toBe('Meta Addiction Treatment (Haverhill)');
    expect(parsed.city).toBe('Haverhill');
    expect(parsed.state).toBe('MA');
  });

  it('parses glued city labels', () => {
    const parsed = parseScrapedLabel(
      'Peace Valley RecoveryDoylestown, PennsylvaniaInsurance accepted',
    );
    expect(parsed.city).toBe('Doylestown');
    expect(parsed.state).toBe('PA');
  });
});

describe('baseFacilityName', () => {
  it('strips trailing parenthetical city', () => {
    expect(baseFacilityName('Meta Addiction Treatment (Haverhill)')).toBe('Meta Addiction Treatment');
  });
});
