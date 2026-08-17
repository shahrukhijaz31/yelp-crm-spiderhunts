import { apiAdmin } from "@/lib/authz";
import { createUser, isRole, listUsers, UserInputError } from "@/lib/userDb";

/**
 * /api/users — the account list, and creating accounts. ADMIN only.
 *
 * The role on a new account comes from this body, which is exactly the kind of
 * client-supplied value that must never be trusted — so it is trusted for
 * nobody: `apiAdmin()` runs first, and only an administrator's request ever
 * reaches the point where `role` is read. An agent posting
 * `{"role": "ADMIN"}` gets a 403 before the JSON is parsed.
 *
 * There is deliberately no endpoint anywhere that lets a user change their own
 * role, at any privilege level. Privilege escalation is not prevented by
 * validation here; it is prevented by the operation not existing.
 */

export async function GET(): Promise<Response> {
  const auth = await apiAdmin();
  if (auth instanceof Response) return auth;

  try {
    // `listUsers` selects an explicit column list that omits `passwordHash`,
    // so no hash can reach this response even by accident.
    const users = await listUsers();
    return Response.json({ users }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("GET /api/users failed:", error);
    return Response.json(
      { error: "database_unavailable", message: "Could not reach the database." },
      { status: 503 },
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
      { status: 400 },
    );
  }

  const payload = body as Record<string, unknown>;
  const role = payload.role;
  if (!isRole(role)) {
    return Response.json(
      { error: "invalid_role", message: "Role must be ADMIN or AGENT." },
      { status: 400 },
    );
  }

  try {
    const user = await createUser({
      name: String(payload.name ?? ""),
      username: String(payload.username ?? ""),
      email: String(payload.email ?? ""),
      password: String(payload.password ?? ""),
      role,
    });

    return Response.json({ user }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof UserInputError) {
      return Response.json({ error: "invalid_input", message: error.message }, { status: 400 });
    }
    console.error("POST /api/users failed:", error);
    return Response.json(
      { error: "database_unavailable", message: "Could not save the new user." },
      { status: 503 },
    );
  }
}
