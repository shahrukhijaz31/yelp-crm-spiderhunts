import { config as loadEnv } from "dotenv";

/**
 * Run the screenshot retention sweep from the command line.
 *
 *   npm run screenshots:retention
 *
 * For development and for a one-off manual run on the server. **Production
 * schedules the sweep through cron**, which calls
 * `POST /api/maintenance/screenshot-retention` inside the running application —
 * see `deploy/leadportal-screenshot-retention` and the note at the top of that
 * route for why a timer inside the app would be wrong.
 *
 * This does exactly the same thing that route does, in the same code, with the
 * same configuration. It takes no arguments on purpose: there is no way to make
 * it delete a different set of screenshots than the configured retention window
 * selects, because there is nothing to pass it.
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

async function main(): Promise<void> {
  // Imported after the environment is loaded: `lib/prisma.ts` throws at import
  // time when DATABASE_URL is missing, and the point of dotenv above is that it
  // is missing until this line has run.
  const { runScreenshotRetention } = await import("../lib/screenshotRetention");
  const { prisma } = await import("../lib/prisma");

  try {
    const result = await runScreenshotRetention();
    if (result.failed > 0) process.exitCode = 1;
    if (result.truncated) {
      console.log(
        "[screenshot-retention] the per-run cap was reached; run again to continue the backlog.",
      );
    }
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

main().catch((error) => {
  console.error("[screenshot-retention] failed:", error);
  process.exit(1);
});
