import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client";

/**
 * The one Prisma Client for the process.
 *
 * Next's dev server re-evaluates modules on every hot reload, so a plain
 * module-level `new PrismaClient()` would open a fresh connection pool per edit
 * until Postgres refuses new connections. Stashing the instance on `globalThis`
 * survives reload; in production the module is evaluated once and the global is
 * left alone.
 *
 * Prisma 7 talks to Postgres through a driver adapter (`@prisma/adapter-pg`)
 * rather than a bundled query engine, so the connection string is handed to the
 * adapter here rather than read from the schema.
 */

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Add it to .env.local — see the setup notes in README.md.",
    );
  }

  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    // Queries are noisy; warnings and errors are the ones worth seeing while
    // developing, and both are silent in production.
    log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
