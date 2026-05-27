/** Sonia's Calendly (or other) booking URL — optional; CTAs fall back to time-slot asks when unset. */
export const getBookingLink = (): string | null => {
  const v = process.env.CALENDLY_LINK?.trim();
  if (v === undefined || v === '') return null;
  return v;
};
