import { z } from 'zod';
import { upsertLead } from '../../shared/lead.js';

const PLACES_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.userRatingCount,places.rating,places.businessStatus,nextPageToken';
const PAGE_SIZE = 20;
const MAX_PAGES = 3;
const PAGE_TOKEN_DELAY_MS = 2000;

const DisplayNameSchema = z.object({
  text: z.string(),
});

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
  nextPageToken: z.string().optional(),
});

type ParsedAddress = {
  street: string | null;
  city: string;
  state: string;
  zip: string | null;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const parseFormattedAddress = (formattedAddress: string): ParsedAddress | null => {
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

const fetchSearchPage = async (
  query: string,
  lat: number,
  lng: number,
  radiusMeters: number,
  pageToken?: string,
): Promise<z.infer<typeof PlacesSearchResponseSchema>> => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new Error('GOOGLE_MAPS_API_KEY is not set');
  }

  const body: Record<string, unknown> = {
    textQuery: query,
    pageSize: PAGE_SIZE,
    locationBias: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: radiusMeters,
      },
    },
  };
  if (pageToken !== undefined) {
    body.pageToken = pageToken;
  }

  const res = await fetch(PLACES_SEARCH_URL, {
    method: 'POST',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': FIELD_MASK,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google Places search failed: ${res.status} ${res.statusText} — ${errText}`);
  }

  const json: unknown = await res.json();
  return PlacesSearchResponseSchema.parse(json);
};

export const scrapePlaces = async (
  query: string,
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<number> => {
  let upserted = 0;
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0 && pageToken === undefined) break;
    if (page > 0) await sleep(PAGE_TOKEN_DELAY_MS);

    const data = await fetchSearchPage(query, lat, lng, radiusMeters, pageToken);
    const places = data.places ?? [];

    for (const place of places) {
      if (place.businessStatus !== 'OPERATIONAL') continue;

      const name = place.displayName?.text?.trim() ?? '';
      if (name === '') continue;

      const formattedAddress = place.formattedAddress?.trim() ?? '';
      if (formattedAddress === '') continue;

      const parsed = parseFormattedAddress(formattedAddress);
      if (parsed === null) continue;

      await upsertLead({
        source: 'gmaps',
        name,
        street: parsed.street,
        city: parsed.city,
        state: parsed.state,
        zip: parsed.zip,
        phone: place.nationalPhoneNumber ?? null,
        website: place.websiteUri ?? null,
        googleRating: place.rating ?? null,
        googleReviews:
          place.userRatingCount !== undefined ? Math.trunc(place.userRatingCount) : null,
        services: [],
        sourceMeta: place,
      });
      upserted += 1;
    }

    pageToken = data.nextPageToken;
    if (pageToken === undefined) break;
  }

  return upserted;
};
