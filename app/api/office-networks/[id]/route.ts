import { apiAdmin } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { invalidateOfficeNetworks, listOfficeNetworks } from "@/lib/workLocation";

/**
 * DELETE /api/office-networks/:id — stop treating an address as the office.
 *
 * Administrators only. Time already recorded keeps the label it was given;
 * only signals from now on are judged against the shorter list.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const auth = await apiAdmin(request);
  if (auth instanceof Response) return auth;

  const { id } = await params;
  await prisma.officeNetwork.deleteMany({ where: { id } });
  invalidateOfficeNetworks();
  return Response.json(
    { networks: await listOfficeNetworks() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
