import { config as loadEnv } from "dotenv";
import { defineConfig, env } from "prisma/config";

/**
 * Prisma CLI configuration.
 *
 * Next.js loads `.env.local` for the app itself, but the Prisma CLI runs
 * outside Next and does not, so it is loaded explicitly here. `.env.local`
 * wins over `.env`, matching Next's own precedence — dotenv never overwrites
 * an already-set key, so listing it first is what makes it the override.
 * Both are covered by the `.env*` rule already in `.gitignore`.
 */
loadEnv({ path: [".env.local", ".env"], quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // Prisma 7 no longer runs the seed as part of `migrate dev` / `migrate
    // reset`; it is an explicit `npx prisma db seed`, aliased as `npm run
    // db:seed`.
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
