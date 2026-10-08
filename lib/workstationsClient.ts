/**
 * The three calls the workstation screens make, in the shape
 * `lib/passwordRecovery.ts` established: the server's own sentence when it has
 * one, a generic sentence when it does not, and the error *code* alongside it
 * so a panel branches on the code rather than on the wording. Matching on
 * copy would make the copy load-bearing, and the first person to soften a
 * message would silently change the flow.
 *
 * Client-side only. Nothing here decides anything — every rule these endpoints
 * enforce is enforced again on the server, which is where it is real.
 */

type Outcome<T> = ({ ok: true } & T) | { ok: false; message: string; code: string };

const NETWORK_MESSAGE = "Could not reach the server. Check your connection and try again.";
const SERVER_MESSAGE = "Something went wrong on our end. Try again in a moment.";

async function post<T>(url: string, body: unknown): Promise<Outcome<T>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, message: NETWORK_MESSAGE, code: "network" };
  }

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    return {
      ok: false,
      message: typeof payload.message === "string" ? payload.message : SERVER_MESSAGE,
      code: typeof payload.error === "string" ? payload.error : "server",
    };
  }

  return { ok: true, ...(payload as T) };
}

/** "Yes, that is my computer." */
export function approveWorkstation(requestId: string): Promise<Outcome<{ deviceName?: string | null }>> {
  return post("/api/account/workstations/approve", { requestId });
}

/** "That was not me." Answers the same way whatever the request turns out to be. */
export function denyWorkstation(requestId: string): Promise<Outcome<Record<string, never>>> {
  return post("/api/account/workstations/deny", { requestId });
}

/** Sign the Monitor out on one machine. Not a portal sign-out, and not a shift. */
export function disconnectWorkstation(deviceId: string): Promise<Outcome<Record<string, never>>> {
  return post("/api/account/workstations/disconnect", { deviceId });
}
