import type { NextFunction, Request, Response } from 'express';

const COOKIE_NAME = 'qpw';
const HEADER_NAME = 'x-queue-pw';

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
  next();
};
