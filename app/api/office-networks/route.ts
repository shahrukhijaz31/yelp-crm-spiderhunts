import { apiAdmin } from "@/lib/authz";
import { clientIp } from "@/lib/loginThrottle";
import { prisma } from "@/lib/prisma";
import { invalidateOfficeNetworks, listOfficeNetworks } from "@/lib/workLocation";
import { isIpAddress } from "@/lib/workLocationRules";

/**
 * GET  /api/office-networks — the office address list, plus the caller's own
 *                             address so the Settings page can offer "add this
 *                             one" from inside the office.
 * POST /api/office-networks — `{ "ip": "39.60.232.90", "label": "Office" }`.
 *
 * Administrators only. These addresses decide whether a contributor's time is
 * recorded as office or remote (`lib/workLocation.ts`); changing them changes
 * how future time is labelled, never time already recorded.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await apiAdmin(request);
  if (auth instanceof Response) return auth;

  return Response.json(
    { networks: await listOfficeNetworks(), yourIp: clientIp(request) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const auth = await apiAdmin(request);
  if (auth instanceof Response) return auth;

  let body: { ip?: unknown; label?: unknown } | null;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json(
      { error: "invalid_json", message: "Request body must be JSON." },
      { status: 400 },
    );
  }

  const ip = typeof body?.ip === "string" ? body.ip.trim().toLowerCase() : "";
  if (!isIpAddress(ip)) {
    return Response.json(
      { error: "invalid_field", message: "Enter an IP address, like 39.60.232.90." },
      { status: 400 },
    );
  }
  const label = typeof body?.label === "string" ? body.label.trim().slice(0, 80) : "";

  const existing = await prisma.officeNetwork.findUnique({ where: { ip } });
  if (existing) {
    return Response.json(
      { error: "duplicate", message: `${ip} is already an office address.` },
      { status: 409 },
    );
  }

  await prisma.officeNetwork.create({ data: { ip, label, createdById: auth.id } });
  invalidateOfficeNetworks();
  return Response.json(
    { networks: await listOfficeNetworks() },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}
