import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  signOpenTrackToken,
  verifyOpenTrackToken,
} from '../../src/shared/openTrackToken.js';

describe('openTrackToken', () => {
  const priorOpen = process.env.OPEN_TRACK_SECRET;
  const priorUnsub = process.env.UNSUBSCRIBE_SECRET;

  beforeEach(() => {
    process.env.OPEN_TRACK_SECRET = 'test-open-track-secret';
    delete process.env.UNSUBSCRIBE_SECRET;
  });

  afterEach(() => {
    if (priorOpen === undefined) delete process.env.OPEN_TRACK_SECRET;
    else process.env.OPEN_TRACK_SECRET = priorOpen;
    if (priorUnsub === undefined) delete process.env.UNSUBSCRIBE_SECRET;
    else process.env.UNSUBSCRIBE_SECRET = priorUnsub;
  });

  it('signs and verifies a draft id', () => {
    const draftId = 'clxyz123draft';
    const sig = signOpenTrackToken(draftId);
    expect(verifyOpenTrackToken(draftId, sig)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const sig = signOpenTrackToken('draft-a');
    expect(verifyOpenTrackToken('draft-b', sig)).toBe(false);
  });

  it('falls back to UNSUBSCRIBE_SECRET when OPEN_TRACK_SECRET is unset', () => {
    delete process.env.OPEN_TRACK_SECRET;
    process.env.UNSUBSCRIBE_SECRET = 'shared-fallback-secret';
    const sig = signOpenTrackToken('draft-fallback');
    expect(verifyOpenTrackToken('draft-fallback', sig)).toBe(true);
  });
});
