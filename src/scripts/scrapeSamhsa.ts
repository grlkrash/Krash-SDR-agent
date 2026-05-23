// tsx src/scripts/scrapeSamhsa.ts 27.6648 -81.5158 500

import 'dotenv/config';
import { scrapeSamhsa } from '../pipeline/sources/samhsa.js';

const [, , latArg, lngArg, radiusArg] = process.argv;

const lat = Number(latArg);
const lng = Number(lngArg);
const radiusMiles = Number(radiusArg);

if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radiusMiles)) {
  throw new Error('Usage: tsx src/scripts/scrapeSamhsa.ts <lat> <lng> <radiusMiles>');
}

const count = await scrapeSamhsa(lat, lng, radiusMiles);
console.log(JSON.stringify({ upserted: count }));
