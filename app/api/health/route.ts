import { prisma } from "@/lib/prisma";

/**
 * GET /api/health — is this process able to serve?
 *
 * `deploy.sh` polls this against the *new* release before nginx is pointed at
 * it, so a release that boots but cannot reach Postgres never takes traffic.
 * That is why it checks the database rather than just returning 200: a process
 * that is listening but has no database is exactly the failure this must catch,
 * and an HTTP 200 from a bare liveness route would wave it through.
 *
 * `SELECT 1` and nothing more — no table access, so it stays honest about
 * connectivity without depending on the schema being migrated yet.
 *
 * Deliberately unauthenticated (the nginx vhost exempts this one path): the
 * deploy script and any uptime check have to reach it without credentials. It
 * discloses nothing beyond up/down and the version already visible in the UI.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json(
      { status: "ok", database: "up" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Health check failed:", error);
    return Response.json(
      { status: "error", database: "down" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
