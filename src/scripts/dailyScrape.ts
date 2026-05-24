import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { CITIES, QUERIES, scrapePlaces } from '../pipeline/sources/places.js';
import { scrapeSamhsa } from '../pipeline/sources/samhsa.js';

const TARGETS = [
  { lat: 27.6648, lng: -81.5158, radius: 500 }, // FL
  { lat: 36.7783, lng: -119.4179, radius: 500 }, // CA
  { lat: 31.9686, lng: -99.9018, radius: 500 }, // TX
  { lat: 40.4173, lng: -82.9071, radius: 300 }, // OH
  { lat: 42.1657, lng: -74.9481, radius: 300 }, // NY
];

// SAMHSA covers daily volume; Places is paid gap-fill on Mondays only.
const PLACES_RADIUS_M = 50000;
const MIN_UPSERTED = 100;
const MONDAY = 1;

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });

let totalUpserted = 0;
try {
  for (const t of TARGETS) {
    totalUpserted += await scrapeSamhsa(t.lat, t.lng, t.radius);
  }
  if (new Date().getDay() === MONDAY) {
    for (const city of Object.values(CITIES)) {
      for (const q of QUERIES) {
        totalUpserted += await scrapePlaces(q, city.lat, city.lng, PLACES_RADIUS_M);
      }
    }
  }
  await prisma.auditLog.create({ data: { action: 'cron.success', entity: 'dailyScrape', meta: { totalUpserted } } });
  console.log(JSON.stringify({ totalUpserted }));
  process.exitCode = totalUpserted < MIN_UPSERTED ? 1 : 0;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  await prisma.auditLog.create({ data: { action: 'cron.failure', entity: 'dailyScrape', meta: { error: message } } });
  throw error;
}
