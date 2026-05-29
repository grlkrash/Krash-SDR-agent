import jwt from 'jsonwebtoken';

const EXPIRES_IN = '10y';

const secret = (): string => {
  const s = process.env.UNSUBSCRIBE_SECRET;
  if (s === undefined || s === '') {
    throw new Error('UNSUBSCRIBE_SECRET is not set');
  }
  return s;
};

export const signPhoneConsentToken = (leadId: string): string =>
  jwt.sign({ leadId, purpose: 'phone-vm-pewc' }, secret(), { expiresIn: EXPIRES_IN });

export const verifyPhoneConsentToken = (token: string): { leadId: string } | null => {
  try {
    const payload = jwt.verify(token, secret());
    if (typeof payload !== 'object' || payload === null) return null;
    const leadId = (payload as { leadId?: unknown }).leadId;
    const purpose = (payload as { purpose?: unknown }).purpose;
    if (typeof leadId !== 'string' || leadId === '') return null;
    if (purpose !== 'phone-vm-pewc') return null;
    return { leadId };
  } catch {
    return null;
  }
};
