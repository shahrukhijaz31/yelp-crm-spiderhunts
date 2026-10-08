import { TRACKED_ROLES } from "@/lib/access";
import { apiRole } from "@/lib/authz";
import { clientIp } from "@/lib/loginThrottle";
import {
  WorkLocationError,
  currentLocationStatus,
  setLocationChoice,
} from "@/lib/workLocation";
import { WORK_LOCATIONS, type WorkLocation } from "@/lib/workLocationRules";

/**
 * GET  /api/work-location — where the signed-in person is being recorded.
 * POST /api/work-location — `{ "location": "office" | "remote" }`: where they
 *                            are working, for the shift they are on.
 *
 * Agents and contributors — the roles tracked for location
 * (`isLocationTracked`). Both act on the session's own user — there is no
 * parameter that names anybody else. A choice belongs to the open shift and is
 * asked for again on the next one (see `lib/workLocation.ts`). The address is
 * recorded beside the stretch for the record only; it decides nothing.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await apiRole([...TRACKED_ROLES], request);
  if (auth instanceof Response) return auth;

  const location = await currentLocationStatus(auth);
  return Response.json({ location }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  const auth = await apiRole([...TRACKED_ROLES], request);
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

  const location = (body as { location?: unknown } | null)?.location;
  if (typeof location !== "string" || !(WORK_LOCATIONS as readonly string[]).includes(location)) {
    return Response.json(
      { error: "invalid_field", message: "location must be office or remote." },
      { status: 400 },
    );
  }

  try {
    const status = await setLocationChoice(auth, clientIp(request), location as WorkLocation);
    return Response.json({ location: status }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof WorkLocationError) {
      return Response.json({ error: "unavailable", message: error.message }, { status: 409 });
    }
    console.error("POST /api/work-location failed:", error);
    return Response.json(
      { error: "database_unavailable", message: "Could not save where you are working." },
      { status: 503 },
    );
  }
}
