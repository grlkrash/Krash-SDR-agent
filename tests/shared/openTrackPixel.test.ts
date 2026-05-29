import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  buildOpenTrackPixelHtml,
  buildOpenTrackPixelUrl,
} from '../../src/shared/openTrackPixel.js';

describe('openTrackPixel', () => {
  const priorPublic = process.env.PUBLIC_URL;
  const priorSecret = process.env.OPEN_TRACK_SECRET;

  beforeEach(() => {
    process.env.PUBLIC_URL = 'https://ssa.example.com';
    process.env.OPEN_TRACK_SECRET = 'pixel-test-secret';
  });

  afterEach(() => {
    if (priorPublic === undefined) delete process.env.PUBLIC_URL;
    else process.env.PUBLIC_URL = priorPublic;
    if (priorSecret === undefined) delete process.env.OPEN_TRACK_SECRET;
    else process.env.OPEN_TRACK_SECRET = priorSecret;
  });

  it('builds a signed track URL under PUBLIC_URL', () => {
    const url = buildOpenTrackPixelUrl('draft-99');
    expect(url.startsWith('https://ssa.example.com/track/open/draft-99?sig=')).toBe(true);
  });

  it('embeds the pixel as a hidden img', () => {
    const html = buildOpenTrackPixelHtml('https://ssa.example.com/track/open/x?sig=y');
    expect(html).toContain('display:none');
    expect(html).toContain('width="1"');
    expect(html).toContain('https://ssa.example.com/track/open/x?sig=y');
  });
});
