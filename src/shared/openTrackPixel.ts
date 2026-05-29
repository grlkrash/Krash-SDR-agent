import { signOpenTrackToken } from './openTrackToken.js';

const requirePublicUrl = (): string => {
  const raw = process.env.PUBLIC_URL?.trim() ?? '';
  if (raw === '') throw new Error('PUBLIC_URL is not set');
  return raw.replace(/\/+$/, '');
};

export const buildOpenTrackPixelUrl = (draftId: string): string => {
  const sig = signOpenTrackToken(draftId);
  const base = requirePublicUrl();
  return `${base}/track/open/${encodeURIComponent(draftId)}?sig=${encodeURIComponent(sig)}`;
};

export const buildOpenTrackPixelHtml = (pixelUrl: string): string =>
  `<img src="${pixelUrl}" width="1" height="1" alt="" style="display:none;border:0;outline:none;" />`;
