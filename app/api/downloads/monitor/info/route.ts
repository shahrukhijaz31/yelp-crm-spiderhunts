import { apiUser } from "@/lib/authz";
import { installerStatus, monitorRelease } from "@/lib/monitorRelease";

/**
 * GET /api/downloads/monitor/info — what is on offer, without the 77MB.
 *
 * The download panel is server-rendered and already has these figures, so this
 * endpoint is not how the screen is painted. It exists for the moment *after*
 * that: an agent leaves a tab open, an operator swaps the installer, and the
 * button in front of them is now describing a file that is not there. The panel
 * asks here first and only then navigates, which is the difference between a
 * sentence explaining the situation and a browser tab full of raw JSON.
 *
 * Same authentication as the download itself — `apiUser()`, both roles, session
 * resolved from Postgres. There is no reason for this to be the softer of the
 * two: it describes the same object.
 *
 * **What it deliberately does not return**: the path, the environment variable
 * it came from, whether that variable is set, or any error from the filesystem.
 * `available: false` is the whole failure vocabulary, and it means the same
 * thing to an agent whether the file is missing, unreadable or a directory.
 */

export async function GET(): Promise<Response> {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;

  const release = monitorRelease();
  const { sizeBytes, updatedAt } = await installerStatus();

  return Response.json(
    {
      ...release,
      available: sizeBytes !== null,
      sizeBytes,
      updatedAt,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
