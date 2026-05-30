import { describe, it, expect } from 'vitest';
import { scanLeaks } from '../../src/outreach/leakScan.js';

describe('scanLeaks', () => {
  it('allows industry YoY stat sentences with cost wording', () => {
    const body = [
      'Robert, your center serves Wauchula well.',
      'The cost of paid search for drug rehab facility keywords rose 124% year over year, and drug rehab terms up 62%.',
      'Sobriety Select is a map-forward directory with rich profiles and verified reviews.',
      'Grab a time here if helpful.',
    ].join(' ');
    expect(scanLeaks(body)).toEqual([]);
  });

  it('blocks SS pricing leaks', () => {
    const body = 'Our listing fee is $9600 per year for your facility.';
    const hits = scanLeaks(body);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.label === 'dollar amount' || h.label === 'pricing word')).toBe(true);
  });

  it('blocks tier name leaks', () => {
    const body = 'The Premium tier includes enhanced placement.';
    expect(scanLeaks(body).some((h) => h.label === 'capitalized tier name')).toBe(true);
  });

  it('ignores facility name containing Premium', () => {
    const body = 'Premium Recovery Center in Austin would benefit from Sobriety Select.';
    expect(scanLeaks(body, ['Premium Recovery Center'])).toEqual([]);
  });
});
