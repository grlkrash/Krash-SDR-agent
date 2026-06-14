import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

declare global {
  var __PRISMA_CLIENT__: PrismaClient | undefined;
}

export const prisma =
  global.__PRISMA_CLIENT__ ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
  });

if (global.__PRISMA_CLIENT__ === undefined) {
  global.__PRISMA_CLIENT__ = prisma;
}
