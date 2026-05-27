// Normalize a facility website to a registrable domain for dedup / matching.

export const extractDomain = (website: string | null | undefined): string | null => {
  if (website === null || website === undefined || website.trim() === '') return null;
  let hostname: string;
  try {
    const withProtocol = /^https?:\/\//i.test(website) ? website : `http://${website}`;
    hostname = new URL(withProtocol).hostname;
  } catch {
    return null;
  }
  const domain = hostname.replace(/^www\./i, '').toLowerCase();
  return domain === '' ? null : domain;
};
