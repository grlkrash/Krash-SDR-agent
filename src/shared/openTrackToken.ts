import { createHmac, timingSafeEqual } from 'node:crypto';

const openTrackSecret = (): string => {
  const dedicated = process.env.OPEN_TRACK_SECRET?.trim() ?? '';
  if (dedicated !== '') return dedicated;
  const fallback = process.env.UNSUBSCRIBE_SECRET?.trim() ?? '';
  if (fallback !== '') return fallback;
  throw new Error('OPEN_TRACK_SECRET or UNSUBSCRIBE_SECRET must be set');
};

export const signOpenTrackToken = (draftId: string): string =>
  createHmac('sha256', openTrackSecret()).update(draftId).digest('hex');

export const verifyOpenTrackToken = (draftId: string, sig: string): boolean => {
  if (sig === '' || draftId === '') return false;
  const expected = signOpenTrackToken(draftId);
  if (expected.length !== sig.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
};
