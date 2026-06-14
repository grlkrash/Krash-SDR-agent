import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  __PRISMA_CLIENT__?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.__PRISMA_CLIENT__ ??
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
  });

globalForPrisma.__PRISMA_CLIENT__ = prisma;
