import { readFile } from "node:fs/promises";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { toCreateData } from "../lib/leadMapping";
import { getMockLeads } from "../lib/mockLeads";
import { parseLeadsCsv } from "../lib/parseLeadsCsv";
import type { Lead } from "../lib/types";

/**
 * Fill a fresh dev database, so a reset is a working portal rather than an
 * empty table.
 *
 *   npm run db:seed              -> public/sample-leads.csv
 *   npm run db:seed -- --demo    -> the sample dataset from lib/mockLeads.ts
 *
 * Both modes exist because they answer different questions. The CSV path goes
 * through `parseLeadsCsv`, so it exercises the same column aliases, phone
 * validation and de-duplication a real upload does — a bug there surfaces here
 * instead of hiding until someone imports a file. But a scraper CSV carries no
 * agent-owned fields, so everything lands on "Not called" and the Callbacks,
 * Meetings and Reports views come up empty. `--demo` seeds the mock dataset
 * instead, which has statuses, callbacks and booked meetings spread around
 * today, and is the one to use when working on those screens.
 *
 * Prisma 7 never runs seeds on its own — not on `migrate dev`, not on
 * `migrate reset`. It is always this explicit step.
 */

// `prisma db seed` spawns this through tsx, which does not load `.env.local`.
// Only plain imports run above this line: pulling in anything that constructs a
// Prisma Client at module scope would do so before the URL is in the
// environment, because ES imports are evaluated before any statement here.
loadEnv({ path: [".env.local", ".env"], quiet: true });

const SAMPLE_CSV = path.join(process.cwd(), "public", "sample-leads.csv");

async function loadFromCsv(): Promise<{ leads: Lead[]; batch: string; note: string }> {
  const csv = await readFile(SAMPLE_CSV, "utf8");
  const batch = "seed-sample-leads";
  const parsed = parseLeadsCsv(csv, batch);

  for (const warning of parsed.warnings) console.warn(`  warning: ${warning}`);
  if (parsed.leads.length === 0) throw new Error(`No usable rows in ${SAMPLE_CSV}.`);

  return {
    leads: parsed.leads,
    batch,
    note:
      `from ${path.relative(process.cwd(), SAMPLE_CSV)} ` +
      `(${parsed.removedNoPhone} without a phone and ${parsed.removedDuplicates} duplicate(s) filtered out)`,
  };
}

function loadFromMocks(): { leads: Lead[]; batch: string; note: string } {
  const leads = getMockLeads();
  return { leads, batch: "seed-demo", note: "from lib/mockLeads.ts (statuses and meetings included)" };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Add it to .env.local before seeding.");
  }

  const demo = process.argv.includes("--demo");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    // Only seed an empty table. Re-running must not bury a real worklist under
    // sample data, and must not silently double it either.
    const existing = await prisma.lead.count();
    if (existing > 0) {
      console.log(
        `Skipped: ${existing} lead(s) already in the database. ` +
          "Run `npm run db:reset` first if you want a clean seed.",
      );
      return;
    }

    const { leads, batch, note } = demo ? loadFromMocks() : await loadFromCsv();
    const { count } = await prisma.lead.createMany({
      data: leads.map((lead) => toCreateData(lead, batch)),
    });

    console.log(`Seeded ${count} lead(s) ${note}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
