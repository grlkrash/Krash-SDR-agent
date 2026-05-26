import "dotenv/config";
import { defineConfig } from "prisma/config";

const BUILD_PLACEHOLDER_URL = "postgresql://build:build@127.0.0.1:5432/build";

/** True only for `prisma generate` — must not use a fake URL for migrate/deploy. */
const isPrismaGenerateOnly = (): boolean => {
  const args = process.argv;
  const hasGenerate = args.some((a) => a === "generate" || a.endsWith("/generate"));
  const hasMigrate = args.some((a) => a === "migrate" || a.includes("migrate"));
  return hasGenerate && !hasMigrate;
};

const resolveDatabaseUrl = (): string => {
  const fromEnv = process.env.DATABASE_URL?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  if (isPrismaGenerateOnly()) return BUILD_PLACEHOLDER_URL;

  throw new Error(
    [
      "DATABASE_URL is not set.",
      "",
      "Railway: on the ssa-web AND ssa-cron services → Variables → add:",
      "  DATABASE_URL = ${{Postgres.DATABASE_URL}}",
      "(use your Postgres plugin service name if it is not called Postgres).",
      "",
      "Then redeploy. migrate deploy must not run against the build placeholder.",
    ].join("\n"),
  );
};

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: resolveDatabaseUrl(),
  },
});
