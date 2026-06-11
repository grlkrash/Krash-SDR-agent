// One-off Google Places text search for intel lookup (not batch scrape).

import { z } from 'zod';
import { logPlacesUsage } from '../shared/costUsage.js';

const PLACES_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.userRatingCount,places.rating,places.businessStatus';

const DisplayNameSchema = z.object({ text: z.string() });

const PlaceSchema = z
  .object({
    id: z.string().optional(),
    displayName: DisplayNameSchema.optional(),
    formattedAddress: z.string().optional(),
    nationalPhoneNumber: z.string().optional(),
    websiteUri: z.string().optional(),
    userRatingCount: z.number().optional(),
    rating: z.number().optional(),
    businessStatus: z.string().optional(),
  })
  .passthrough();

const PlacesSearchResponseSchema = z.object({
  places: z.array(PlaceSchema).optional(),
});

export type PlaceLookupResult = {
  name: string;
  street: string | null;
  city: string;
  state: string;
  zip: string | null;
  phone: string | null;
  website: string | null;
  googleRating: number | null;
  googleReviews: number | null;
  placeId: string | null;
};

const parseFormattedAddress = (formattedAddress: string): Omit<PlaceLookupResult, 'name' | 'phone' | 'website' | 'googleRating' | 'googleReviews' | 'placeId'> | null => {
  const parts = formattedAddress.split(', ').map((p) => p.trim());
  if (parts.length < 3) return null;
  const stateZipPart = parts[parts.length - 2];
  const city = parts[parts.length - 3];
  const streetParts = parts.slice(0, parts.length - 3);
  const stateZipTokens = stateZipPart.split(' ');
  if (stateZipTokens.length < 2) return null;
  const state = stateZipTokens[0];
  const zip = stateZipTokens.slice(1).join(' ') || null;
  const street = streetParts.length > 0 ? streetParts.join(', ') : null;
  return { street, city, state, zip };
};

/** Best-effort match for a facility name (+ optional city/state). */
export const lookupPlace = async (
  name: string,
  city?: string | null,
  state?: string | null,
): Promise<PlaceLookupResult | null> => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (apiKey === undefined || apiKey === '') return null;

  const location = [city, state].filter((p) => p !== undefined && p !== null && p.trim() !== '').join(', ');
  const textQuery = location === '' ? name : `${name} ${location}`;

  const res = await fetch(PLACES_SEARCH_URL, {
    method: 'POST',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ textQuery, pageSize: 5 }),
  });

  if (!res.ok) return null;

  const json: unknown = await res.json();
  logPlacesUsage('places.searchText');
  const data = PlacesSearchResponseSchema.parse(json);
  const places = data.places ?? [];

  for (const place of places) {
    if (place.businessStatus !== undefined && place.businessStatus !== 'OPERATIONAL') continue;
    const displayName = place.displayName?.text?.trim() ?? '';
    if (displayName === '') continue;
    const formattedAddress = place.formattedAddress?.trim() ?? '';
    if (formattedAddress === '') continue;
    const parsed = parseFormattedAddress(formattedAddress);
    if (parsed === null) continue;
    return {
      name: displayName,
      street: parsed.street,
      city: parsed.city,
      state: parsed.state,
      zip: parsed.zip,
      phone: place.nationalPhoneNumber ?? null,
      website: place.websiteUri ?? null,
      googleRating: place.rating ?? null,
      googleReviews:
        place.userRatingCount !== undefined ? Math.trunc(place.userRatingCount) : null,
      placeId: place.id ?? null,
    };
  }

  return null;
};
