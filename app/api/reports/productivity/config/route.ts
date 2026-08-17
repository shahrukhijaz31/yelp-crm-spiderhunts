import { apiAdmin } from "@/lib/authz";
import { readProductivityConfig, writeProductivityConfig } from "@/lib/productivity";
import { ProductivityConfigError } from "@/lib/productivityRules";

/**
 * GET / PUT /api/reports/productivity/config — the targets and weights.
 * ADMIN only, on both verbs.
 *
 * `apiAdmin()` opens each handler, before the body is even read. Reading the
 * configuration is admin-only as well as writing it: the brief is explicit that
 * an agent must not see the productivity configuration, and it would in any case
 * tell them precisely how to raise a score they are not shown.
 *
 * ---------------------------------------------------------------------------
 * Why this is a `config` segment under a dynamic sibling, and why that is safe
 * ---------------------------------------------------------------------------
 * `[agentId]` sits beside this directory. Next resolves a literal segment before
 * a dynamic one, so `/config` always reaches this file and never the agent
 * detail route. The two cannot collide on real data either — ids in this
 * application are cuids, which are twenty-five characters beginning with `c`,
 * and `config` is neither.
 *
 * ---------------------------------------------------------------------------
 * The write
 * ---------------------------------------------------------------------------
 * PUT rather than POST: there is one configuration row, always at the same id,
 * and the body is the whole of it. Sending a partial body is a validation
 * failure rather than a merge, deliberately — the weights must total 100, and a
 * patch that changes one of them cannot be checked against four values the
 * caller did not send and may not have been looking at.
 *
 * Validation is `validateProductivityConfig`, which refuses rather than clamps
 * and names the offending field. Nothing is written unless every value passes,
 * so a rejected request leaves the previous configuration exactly as it was.
 *
 * The author is the session user, read from the session row. There is no field
 * in the accepted body that names one.
 */
export async function GET(): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  try {
    return Response.json(
      { config: await readProductivityConfig() },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("GET /api/reports/productivity/config failed:", error);
    return Response.json(
      { error: "server_error", message: "Could not load the configuration. Try again." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function PUT(request: Request): Promise<Response> {
  const auth = await apiAdmin(request);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "invalid_body", message: "Request body must be a JSON object." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const config = await writeProductivityConfig(auth.id, body);
    return Response.json({ config }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ProductivityConfigError) {
      return Response.json(
        { error: error.code, message: error.message, field: error.field ?? null },
        { status: error.status, headers: { "Cache-Control": "no-store" } },
      );
    }

    console.error("PUT /api/reports/productivity/config failed:", error);
    return Response.json(
      { error: "server_error", message: "Could not save the configuration. Try again." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
