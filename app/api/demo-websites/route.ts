import { apiAdmin, apiModule } from "@/lib/authz";
import {
  createDemoWebsite,
  isDemoRefusal,
  listDemoWebsites,
  parseDemoWebsiteCreate,
} from "@/lib/demoWebsites";
import { parseDemoWebsiteParams } from "@/lib/demoWebsiteRules";
import { DEMO_WEBSITE_SEARCH_LIMIT, rateLimitRefusal } from "@/lib/rateLimit";

/**
 * /api/demo-websites — the list, and creating one.
 *
 * ---------------------------------------------------------------------------
 * Two different guards, on purpose
 * ---------------------------------------------------------------------------
 *   GET   `apiModule("demoWebsites")` — administrators, and agents whose
 *         account has the Demo Websites module. Resolved from the session row
 *         and the `users` row in Postgres on every request.
 *   POST  `apiAdmin()` — administrators only. Agents are read-only in this
 *         module, and that is enforced here rather than by the panel not
 *         drawing an Add button.
 *
 * They are separate calls in separate handlers rather than one guard for the
 * file, because a single module gate covering both would make POST reachable by
 * any agent with read access — the exact mistake this split exists to make
 * impossible. Every endpoint in this module states its own rule; nothing is
 * inherited.
 *
 * ---------------------------------------------------------------------------
 * Nothing about the caller comes from the request
 * ---------------------------------------------------------------------------
 * There is no `userId`, `agentId`, `role` or `permissions` field anywhere in
 * these bodies, and if one were sent it would be ignored: `parseDemoWebsiteCreate`
 * is a whitelist of seven content fields, and the author written to the row is
 * `auth.id` from the session. The query parameters are filters and only
 * filters — they narrow a read that has already been authorized, and none of
 * them is ever consulted to decide whether the caller may see anything.
 *
 * Not cached, like the rest of the API: an administrator who saves an edit
 * expects the next read to show it.
 */

const noStore = { "Cache-Control": "no-store" } as const;

export async function GET(request: Request): Promise<Response> {
  const auth = await apiModule("demoWebsites");
  if (auth instanceof Response) return auth;

  const query = parseDemoWebsiteParams(new URL(request.url).searchParams);

  // Only a *search* is counted. A status filter or a page turn is an indexed
  // read; the free-text term is the one clause that cannot use an index, and
  // the 200-character cap applied while parsing bounds one search while this
  // bounds how many of them one account can ask for.
  if (query.search.trim() !== "") {
    const limited = await rateLimitRefusal(DEMO_WEBSITE_SEARCH_LIMIT, auth.id);
    if (limited) return limited;
  }

  try {
    const payload = await listDemoWebsites(query);
    return Response.json(payload, { headers: noStore });
  } catch (error) {
    console.error("GET /api/demo-websites failed:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not reach the database. Demo websites could not be loaded.",
      },
      { status: 503, headers: noStore },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const auth = await apiAdmin(request);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400, headers: noStore },
    );
  }

  let input;
  try {
    input = parseDemoWebsiteCreate(body);
  } catch (error) {
    if (isDemoRefusal(error)) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: error.status, headers: noStore },
      );
    }
    throw error;
  }

  try {
    // `auth.id` — the user the session row in Postgres resolved to, never
    // anything the body claimed. There is no author field in the request.
    const demoWebsite = await createDemoWebsite(input, auth.id);
    return Response.json({ demoWebsite }, { status: 201, headers: noStore });
  } catch (error) {
    console.error("POST /api/demo-websites failed:", error);
    return Response.json(
      {
        error: "database_unavailable",
        message: "Could not reach the database. The demo website was not created.",
      },
      { status: 503, headers: noStore },
    );
  }
}
