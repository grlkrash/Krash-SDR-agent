import jwt from 'jsonwebtoken';

const EXPIRES_IN = '10y';

const secret = (): string => {
  const s = process.env.UNSUBSCRIBE_SECRET;
  if (s === undefined || s === '') {
    throw new Error('UNSUBSCRIBE_SECRET is not set');
  }
  return s;
};

export const signUnsubToken = (email: string): string =>
  jwt.sign({ email }, secret(), { expiresIn: EXPIRES_IN });

export const verifyUnsubToken = (token: string): { email: string } | null => {
  try {
    const payload = jwt.verify(token, secret());
    if (typeof payload !== 'object' || payload === null) return null;
    const email = (payload as { email?: unknown }).email;
    if (typeof email !== 'string' || email === '') return null;
    return { email };
  } catch {
    return null;
  }
};
