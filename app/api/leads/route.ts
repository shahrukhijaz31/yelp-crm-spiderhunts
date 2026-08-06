import { listLeads } from "@/lib/leadDb";
import type { Lead } from "@/lib/types";

/**
 * GET /api/leads
 *
 * The read path, now backed by Postgres. The promise the mock version made —
 * "only `getMockLeads()` gets replaced, the response shape stays the same" —
 * held: `{ leads, count, source }` is unchanged apart from `source`, which
 * moved from `"mock"` to `"postgres"`.
 *
 * Not cached: an agent who changes a status expects the next read to show it.
 *
 * Later phases will add here:
 *   - pagination / filter query params, once the table outgrows a single fetch
 */
export async function GET(): Promise<Response> {
  try {
    const leads: Lead[] = await listLeads();

    return Response.json(
      { leads, count: leads.length, source: "postgres" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("GET /api/leads failed:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message:
          "Could not reach the database. Check that Postgres is running and that DATABASE_URL in .env.local is correct.",
      },
      { status: 503 },
    );
  }
}
