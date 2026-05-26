import type { CookieOptions, NextFunction, Request, Response } from 'express';

const COOKIE_NAME = 'qpw';
const HEADER_NAME = 'x-queue-pw';
// 30 days — long enough that Sonia doesn't re-enter ?pw= constantly, short
// enough that a forgotten/shared device eventually re-auths.
const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// Manual cookie parse — we don't pull cookie-parser just to read one value.
const readCookie = (header: string | undefined, name: string): string | undefined => {
  if (header === undefined) return undefined;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    const raw = trimmed.slice(eq + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
};

const readSupplied = (req: Request): string | undefined => {
  const q = req.query.pw;
  if (typeof q === 'string' && q !== '') return q;
  const h = req.headers[HEADER_NAME];
  if (typeof h === 'string' && h !== '') return h;
  return readCookie(req.headers.cookie, COOKIE_NAME);
};

const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  sameSite: 'lax',
  // Render serves the app over HTTPS in production. In dev (NODE_ENV !==
  // 'production') we leave secure=false so localhost over HTTP still works.
  secure: process.env.NODE_ENV === 'production',
  maxAge: COOKIE_MAX_AGE_MS,
  path: '/',
});

export const queueAuth = (req: Request, res: Response, next: NextFunction): void => {
  const expected = process.env.QUEUE_PASSWORD;
  const supplied = readSupplied(req);
  if (
    expected === undefined ||
    expected === '' ||
    supplied === undefined ||
    supplied !== expected
  ) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  // Set/refresh the auth cookie on every successful auth. This is what makes
  // POST → 303 redirect to bare `/queue` work: the form action still carries
  // ?pw= for first-visit priming, but the redirect target itself has no
  // query string, and the cookie picks up the slack from there on.
  res.cookie(COOKIE_NAME, supplied, cookieOptions());
  next();
};
