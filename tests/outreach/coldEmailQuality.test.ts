import { describe, it, expect } from 'vitest';
import {
  assessColdEmailQuality,
  assessColdEmailSubject,
  assessColdDraftQuality,
  bodyWordCount,
  COLD_BODY_MIN_WORDS,
  SUBJECT_MAX_CHARS,
  SUBJECT_MAX_WORDS,
} from '../../src/outreach/coldEmailQuality.js';

const GOLD_BODY = [
  'Robert, Tri County Human Services serves Wauchula with almost no directory presence today, and families searching Hardee County are mostly reaching other centers first.',
  'Paid search for drug rehab facility keywords is up 124% year over year, and drug rehab terms up 62%.',
  'Most operators have only a handful of channels they can advertise on, and those keep getting pricier, which makes census harder to predict when you are competing on the same auctions as everyone else in your region.',
  'Sobriety Select is a map-forward directory where families search by region and insurance, not keyword bids.',
  'Partnership means a complete profile with services, insurance, and verified reviews so inquiries are better aligned, plus a channel that complements your existing outreach instead of another paid-search auction.',
  'If a quick look makes sense for Tri County, grab a time here: https://meetings-na2.hubspot.com/sonia-gibbs',
].join(' ');

const ctx = {
  facilityName: 'Tri County Human Services Inc',
  city: 'Wauchula',
  state: 'FL',
  ownerName: 'Robert',
  services: ['Outpatient'],
};

describe('coldEmailQuality — body', () => {
  it('passes gold-standard body', () => {
    const result = assessColdEmailQuality(GOLD_BODY);
    expect(result.ok).toBe(true);
    expect(bodyWordCount(GOLD_BODY)).toBeGreaterThanOrEqual(COLD_BODY_MIN_WORDS);
  });

  it('flags too-short body', () => {
    const short = 'Hi there, worth a quick call about intake?';
    const result = assessColdEmailQuality(short);
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('too-short');
  });

  it('passes gold-standard body without tripping the free-listing guardrails', () => {
    const result = assessColdEmailQuality(GOLD_BODY);
    expect(result.issues).not.toContain('overpromise');
    expect(result.issues).not.toContain('oversells-invisibility');
  });

  it('flags an outcome overpromise', () => {
    const body = GOLD_BODY.replace(
      'so inquiries are better aligned',
      'and we guarantee we will fill your beds with a flood of inquiries',
    );
    const result = assessColdEmailQuality(body);
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('overpromise');
  });

  it('flags catastrophized invisibility', () => {
    const body = GOLD_BODY.replace(
      'families searching Hardee County are mostly reaching other centers first',
      'families can\'t find you and your center is invisible online',
    );
    const result = assessColdEmailQuality(body);
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('oversells-invisibility');
  });

  it('flags missing SS identity', () => {
    const longButGeneric = [
      'Robert, Tri County Human Services serves Wauchula and Hardee County inquiries often route to other operators before they reach your intake line.',
      'Paid search for drug rehab facility keywords is up 124% year over year in your region and advertising channels keep getting pricier for operators across Florida who depend on those auctions.',
      'Centers in Wauchula compete on the same expensive auctions which makes census harder to predict for smaller facilities like yours even when clinical quality is strong and your team is stretched thin.',
      'We help treatment operators reach more aligned inquiries from people already looking for care in their area without adding another layer of marketing complexity to your intake team this quarter.',
      'Would Tuesday or Thursday work for a quick look at what people in Wauchula see when they look for treatment options near your facility this month?',
    ].join(' ');
    expect(bodyWordCount(longButGeneric)).toBeGreaterThanOrEqual(COLD_BODY_MIN_WORDS);
    const result = assessColdEmailQuality(longButGeneric);
    expect(result.issues).toContain('missing-ss-identity');
  });
});

describe('coldEmailQuality — subject', () => {
  it('passes pain-point colleague subject', () => {
    const result = assessColdEmailSubject('lakeland families reaching competitors', {
      ...ctx,
      city: 'Lakeland',
      facilityName: 'Peace River Center',
    });
    expect(result.ok).toBe(true);
    expect(result.wordCount).toBeLessThanOrEqual(SUBJECT_MAX_WORDS);
    expect(result.charCount).toBeLessThanOrEqual(SUBJECT_MAX_CHARS);
  });

  it('rejects legacy Stevi vendor-pitch subject', () => {
    const result = assessColdEmailSubject('Increase Visibility on SobrietySelect.com!', ctx);
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('vendor-pitch');
    expect(result.issues).toContain('has-exclamation');
  });

  it('rejects generic subject without prospect token', () => {
    const result = assessColdEmailSubject('quick question about intake', {
      ...ctx,
      city: 'Zzzville',
      facilityName: 'Xy Zq',
      ownerName: null,
      services: [],
    });
    expect(result.issues).toContain('missing-prospect-token');
  });

  it('assessColdDraftQuality combines body and subject', () => {
    const draft = assessColdDraftQuality(
      'wauchula intake gap',
      GOLD_BODY,
      ctx,
    );
    expect(draft.ok).toBe(true);
  });
});
