import { fetchVerifiedDirectoryListings } from './fetchDirectoryApi.js';

export type ScrapedDirectoryCenter = {
  rawLabel: string;
  slug: string | null;
  href: string | null;
  name: string;
  city: string | null;
  state: string | null;
  address: string | null;
  subscriptionType: string | null;
};

/** Pull verified SS directory listings via the public search API. */
export const scrapeDirectoryCenters = async (): Promise<ScrapedDirectoryCenter[]> => {
  const listings = await fetchVerifiedDirectoryListings();
  return listings.map((l) => ({
    rawLabel: [l.name, l.city, l.state].filter(Boolean).join(', '),
    slug: l.slug,
    href: `/center-details/${l.slug}`,
    name: l.name,
    city: l.city,
    state: l.state,
    address: l.address,
    subscriptionType: l.subscriptionType,
  }));
};
