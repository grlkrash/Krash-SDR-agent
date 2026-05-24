import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { scrapePlaces } from '../pipeline/sources/places.js';
import { scrapeSamhsa } from '../pipeline/sources/samhsa.js';

const TARGETS = [
  { lat: 27.6648, lng: -81.5158, radius: 500 }, // FL
  { lat: 36.7783, lng: -119.4179, radius: 500 }, // CA
  { lat: 31.9686, lng: -99.9018, radius: 500 }, // TX
  { lat: 40.4173, lng: -82.9071, radius: 300 }, // OH
  { lat: 42.1657, lng: -74.9481, radius: 300 }, // NY
];

// SAMHSA covers daily volume; Places is paid gap-fill on Mondays only.
const PLACES_CITIES = [
  { lat: 25.7617, lng: -80.1918 }, { lat: 27.9506, lng: -82.4572 },
  { lat: 28.5383, lng: -81.3792 }, { lat: 30.3322, lng: -81.6557 },
  { lat: 34.0522, lng: -118.2437 }, { lat: 37.7749, lng: -122.4194 },
  { lat: 32.7157, lng: -117.1611 }, { lat: 29.7604, lng: -95.3698 },
  { lat: 32.7767, lng: -96.797 }, { lat: 30.2672, lng: -97.7431 },
  { lat: 39.9612, lng: -82.9988 }, { lat: 39.1031, lng: -84.512 },
  { lat: 41.4993, lng: -81.6944 }, { lat: 40.7128, lng: -74.006 },
  { lat: 42.8864, lng: -78.8784 },
];
const PLACES_QUERIES = ['treatment center', 'sober living', 'IOP program', 'MAT clinic', 'addiction recovery', 'detox center', 'halfway house'];
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
    for (const city of PLACES_CITIES) {
      for (const q of PLACES_QUERIES) {
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
