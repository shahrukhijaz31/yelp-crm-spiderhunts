import { monitorUser, revokeAllDevicesFor } from "@/lib/monitorAuth";
import { destroyAllSessionsFor } from "@/lib/session";
import { endWorkSessionForLogout } from "@/lib/workSessions";

/**
 * POST /api/monitor/sign-out — the agent pressed Sign out in the Monitor.
 *
 * The same thing as signing out of the portal (`/api/auth/logout`): every
 * browser session the agent has is ended, every Monitor workstation they have
 * is disconnected — this one included — and the shift is closed. Browsers
 * first, for the reason given there: a tab left open would start a new shift
 * on its next heartbeat.
 *
 * **Not `/api/monitor/auth/logout`**, which disconnects one workstation and
 * touches nothing else. The Monitor calling this drops its own credential
 * afterwards and returns to its connect screen.
 *
 * Bearer-authenticated by `monitorUser()`, so the account is the device's
 * owner and never anything the client sent; there is no body. Always 200 once
 * authenticated: there being no open shift is not an error.
 */
export async function POST(request: Request): Promise<Response> {
  const auth = await monitorUser(request);
  if (auth instanceof Response) return auth;

  await destroyAllSessionsFor(auth.id).catch((error) => {
    console.error(`Could not end the browser sessions for ${auth.id}:`, error);
  });
  await revokeAllDevicesFor(auth.id);
  await endWorkSessionForLogout(auth.id);

  return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
