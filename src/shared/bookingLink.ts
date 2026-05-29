/** Sonia's HubSpot meetings link — used in cold, follow-up, nudge, and reply drafts. */
const DEFAULT_BOOKING_LINK = 'https://meetings-na2.hubspot.com/sonia-gibbs';

export const getBookingLink = (): string => {
  const hubspot = process.env.HUBSPOT_BOOKING_LINK?.trim();
  if (hubspot !== undefined && hubspot !== '') return hubspot;
  // Legacy env name — migrate Railway to HUBSPOT_BOOKING_LINK.
  const legacy = process.env.CALENDLY_LINK?.trim();
  if (legacy !== undefined && legacy !== '' && !legacy.includes('calendly.com')) {
    return legacy;
  }
  return DEFAULT_BOOKING_LINK;
};
