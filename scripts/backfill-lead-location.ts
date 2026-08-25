import { config as loadEnv } from "dotenv";

loadEnv({ path: [".env.local", ".env"], quiet: true });

// `lib/leadLocation.ts` is pure and safe to import at the top; `lib/prisma.ts`
// is not, and is pulled in inside `main()` below — it throws at import time
// when DATABASE_URL is unset, and the whole point of the dotenv call above is
// that it *is* unset until that line has run. ES imports are evaluated before
// any statement in this file, so a top-level import of it would lose the race.
import { parseAddressLocation } from "../lib/leadLocation";

/**
 * Fill `leads.country` and `leads.city` from `leads.address`.
 *
 *     npm run leads:backfill-location            # write
 *     npm run leads:backfill-location -- --dry   # report only, change nothing
 *
 * The migration that added the two columns deliberately does not backfill them
 * (see `prisma/migrations/20260825120000_add_lead_location/migration.sql`): the
 * rules for reading an address are TypeScript, in `lib/leadLocation.ts`, and a
 * hand-written SQL translation of them would be a second definition that drifts
 * from the first the moment either is corrected. So the backfill runs the real
 * parser, and this script is the only thing that has to exist for that.
 *
 * **Idempotent and re-runnable, which is the point.** It recomputes every row
 * from the address rather than skipping rows that already have a country, so it
 * is also how a later fix to the parser reaches the leads already in the table
 * — improve a rule, run this, and the stored columns agree with the code again.
 * Rows whose parse is unchanged are not written at all, so a re-run on a
 * settled table is a read.
 *
 * Nothing here writes `updated_at`: it uses a raw `UPDATE` rather than
 * `prisma.lead.update` precisely to leave that column alone. `updated_at` is
 * what orders the Called worklist, and a maintenance script that reshuffled
 * every agent's list to the day it was run would be a visible bug caused by an
 * invisible one.
 */

const DRY_RUN = process.argv.includes("--dry");

/** Rows per read. Bounded so a table of any size costs constant memory. */
const BATCH = 500;

interface Tally {
  scanned: number;
  updated: number;
  unchanged: number;
  /** Rows left with no country after the parse — the ones worth eyeballing. */
  unplaced: number;
}

async function main(): Promise<void> {
  const { prisma } = await import("../lib/prisma");

  const total = await prisma.lead.count();
  console.log(
    `${DRY_RUN ? "Dry run" : "Backfill"} over ${total.toLocaleString()} lead(s)\n`,
  );

  const tally: Tally = { scanned: 0, updated: 0, unchanged: 0, unplaced: 0 };
  const countries = new Map<string, number>();
  /** A few unreadable addresses, quoted at the end so the rules can be fixed. */
  const samples: string[] = [];

  // Keyset pagination on the primary key rather than `skip`/`take`: this is the
  // one traversal in the codebase that reads every row, and an OFFSET deep into
  // a large table re-walks everything before it on each page.
  let cursor: string | null = null;

  for (;;) {
    const rows: { id: string; address: string; country: string | null; city: string | null }[] =
      await prisma.lead.findMany({
        select: { id: true, address: true, country: true, city: true },
        orderBy: { id: "asc" },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    for (const row of rows) {
      tally.scanned += 1;
      const { country, city } = parseAddressLocation(row.address);

      countries.set(country ?? "—", (countries.get(country ?? "—") ?? 0) + 1);
      if (country === null) {
        tally.unplaced += 1;
        if (samples.length < 10 && row.address.trim() !== "") samples.push(row.address);
      }

      if (country === row.country && city === row.city) {
        tally.unchanged += 1;
        continue;
      }

      tally.updated += 1;
      if (DRY_RUN) continue;

      // Raw, so `updated_at` is not stamped — see the note above.
      await prisma.$executeRaw`
        UPDATE leads SET country = ${country}, city = ${city} WHERE id = ${row.id}
      `;
    }

    // Only while there is more to come — the final count is printed below, and
    // writing it twice leaves the last `\r` line sitting beside its own repeat.
    if (rows.length === BATCH) {
      process.stdout.write(
        `  ${tally.scanned.toLocaleString()} / ${total.toLocaleString()}\r`,
      );
    }
  }

  console.log(`  ${tally.scanned.toLocaleString()} / ${total.toLocaleString()}\n`);
  console.log(`  ${DRY_RUN ? "would update" : "updated"}   ${tally.updated.toLocaleString()}`);
  console.log(`  unchanged     ${tally.unchanged.toLocaleString()}`);
  console.log(`  no country    ${tally.unplaced.toLocaleString()}`);

  console.log("\nBy country");
  for (const [code, count] of Array.from(countries).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${code.padEnd(4)} ${count.toLocaleString()}`);
  }

  if (samples.length > 0) {
    console.log("\nAddresses no rule could place (a sample):");
    for (const address of samples) console.log(`  ${address}`);
    console.log("\nIf a shape repeats here, it belongs in lib/leadLocation.ts.");
  }

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
