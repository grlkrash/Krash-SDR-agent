import "dotenv/config";
import { defineConfig } from "prisma/config";

// prisma generate only needs a valid URL shape — not a live DB. Railway/Nixpacks
// builds often run before service variables are injected; use a placeholder then.
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://build:build@127.0.0.1:5432/build";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: DATABASE_URL,
  },
});
