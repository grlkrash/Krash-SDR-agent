import 'dotenv/config';
import { CITIES, QUERIES, scrapePlaces } from '../pipeline/sources/places.js';

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
