import 'dotenv/config';
import { scrapePlaces } from '../pipeline/sources/places.js';

const CITIES = {
  miami: { lat: 25.7617, lng: -80.1918, state: 'FL' },
  tampa: { lat: 27.9506, lng: -82.4572, state: 'FL' },
  orlando: { lat: 28.5383, lng: -81.3792, state: 'FL' },
  jacksonville: { lat: 30.3322, lng: -81.6557, state: 'FL' },
  losAngeles: { lat: 34.0522, lng: -118.2437, state: 'CA' },
  sanFrancisco: { lat: 37.7749, lng: -122.4194, state: 'CA' },
  sanDiego: { lat: 32.7157, lng: -117.1611, state: 'CA' },
  houston: { lat: 29.7604, lng: -95.3698, state: 'TX' },
  dallas: { lat: 32.7767, lng: -96.7970, state: 'TX' },
  austin: { lat: 30.2672, lng: -97.7431, state: 'TX' },
  columbus: { lat: 39.9612, lng: -82.9988, state: 'OH' },
  cincinnati: { lat: 39.1031, lng: -84.5120, state: 'OH' },
  cleveland: { lat: 41.4993, lng: -81.6944, state: 'OH' },
  nyc: { lat: 40.7128, lng: -74.0060, state: 'NY' },
  buffalo: { lat: 42.8864, lng: -78.8784, state: 'NY' },
};

const QUERIES = [
  'treatment center',
  'sober living',
  'IOP program',
  'MAT clinic',
  'addiction recovery',
  'detox center',
  'halfway house',
];

const RADIUS_METERS = 50000;

let totalUpserted = 0;

for (const [cityKey, city] of Object.entries(CITIES)) {
  for (const query of QUERIES) {
    const count = await scrapePlaces(query, city.lat, city.lng, RADIUS_METERS);
    totalUpserted += count;
    console.log(JSON.stringify({ city: cityKey, query, upserted: count }));
  }
}

console.log(JSON.stringify({ totalUpserted }));
