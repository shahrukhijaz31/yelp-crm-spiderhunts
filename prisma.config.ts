import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

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
    // `process.env` directly, NOT prisma/config's `env()` helper. `env()`
    // throws the moment this file is loaded if the variable is missing, and
    // this file is loaded by *every* Prisma command — including `generate`,
    // which is pure codegen and needs no database at all.
    //
    // That eager throw broke `npm ci` on the server: the `postinstall` hook
    // runs `prisma generate` before any deploy step has exported the
    // environment, so the install failed with a config error that had nothing
    // to do with the install. It would break a fresh `npm install` on a new
    // developer machine for the same reason, before there is any .env.local.
    //
    // Commands that genuinely need the URL (`migrate`, `db seed`, `studio`)
    // still fail clearly when it is unset — they just fail at the point of use.
    url: process.env.DATABASE_URL,
  },
});
