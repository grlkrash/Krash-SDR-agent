export const guessEmail = (ownerName: string | null, website: string | null): string | null => {
  if (website === null || website === '') return null;

  let hostname: string;
  try {
    const withProtocol = /^https?:\/\//i.test(website) ? website : `http://${website}`;
    hostname = new URL(withProtocol).hostname;
  } catch {
    return null;
  }
  if (hostname === '') return null;

  const domain = hostname.replace(/^www\./i, '').toLowerCase();
  if (domain === '') return null;

  if (ownerName !== null && ownerName.trim() !== '') {
    const firstName = ownerName.trim().split(/\s+/)[0]?.toLowerCase();
    if (firstName !== undefined && firstName !== '') {
      return `${firstName}@${domain}`;
    }
  }
  return `info@${domain}`;
};
