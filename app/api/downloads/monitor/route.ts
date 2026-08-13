import { apiUser } from "@/lib/authz";
import {
  INSTALLER_CONTENT_TYPE,
  installerStatus,
  installerStream,
  monitorRelease,
} from "@/lib/monitorRelease";

/**
 * GET /api/downloads/monitor — the SpiderHunts Monitor installer.
 *
 * This is the only way the installer leaves the server. It is not under
 * `public/`, nginx has no location for it, and it lives outside the release
 * tree entirely (`/var/lib/leadportal/downloads`), so the bytes are unreachable
 * except through this handler — which resolves the caller from the session row
 * in Postgres before it opens the file.
 *
 * **Both roles, every signed-in user.** `apiUser()` and not `apiRole()`: the
 * Monitor is the software an agent is required to run, so an endpoint that
 * refused agents would refuse the people it exists for. Administrators may
 * download it too, and need to — they install it on their own machines to see
 * what an agent sees. There is deliberately no PUT, POST or DELETE here: the
 * installer is placed on the server during deployment, so no request of any
 * kind from any role can replace it, and an agent cannot change the version by
 * asking. Next answers the other verbs with 405 because they are not exported.
 *
 * **Nothing about the response comes from the request.** No query parameter, no
 * path segment, no header contributes to which file is opened — `lib/monitorRelease.ts`
 * takes no argument at all. So there is no filename to smuggle a `../` into and
 * no second file that could be reached by asking differently; the traversal
 * question is answered by there being nothing to traverse. The server path
 * never appears in a response body or a header either, in success or failure.
 *
 * Headers worth their lines:
 *   Content-Disposition     `attachment` with the canonical filename, so the
 *                           browser saves `SpiderHunts-Monitor-Windows-0.1.0-Setup.exe`
 *                           rather than trying to display an executable.
 *   Content-Length          from `stat`, so the browser can show a progress bar
 *                           and knows when a 77MB download was truncated.
 *   X-Content-Type-Options  `nosniff`, belt and braces with the type above.
 *   Cache-Control           `private, no-store` — the whole authenticated app is
 *                           no-store, and an installer sitting in a shared cache
 *                           is a copy served without a session check.
 *
 * No `Range` support, unlike the recording stream. A download is a whole file
 * from byte zero; ranges are what make an audio element seekable, and the
 * parsing they need would be code with no caller here. A browser that asks for
 * a range gets the whole file, which is what the spec asks of a server that
 * does not advertise `Accept-Ranges`.
 */

export async function GET(): Promise<Response> {
  const auth = await apiUser();
  if (auth instanceof Response) return auth;

  const release = monitorRelease();

  // The size is read from disk rather than remembered, for two reasons: it is
  // what `Content-Length` has to describe, and it is also the existence check —
  // a null size is a file that is missing, unreadable or not a file, and all
  // three are answered identically below.
  const { sizeBytes } = await installerStatus();
  if (sizeBytes === null) {
    return Response.json(
      {
        error: "installer_unavailable",
        // The message an agent will actually see, and it names nothing about
        // the server: not the path, not the variable, not the reason.
        message: "SpiderHunts Monitor is temporarily unavailable. Please try again later.",
      },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  return new Response(installerStream(), {
    status: 200,
    headers: {
      "Content-Type": INSTALLER_CONTENT_TYPE,
      "Content-Length": String(sizeBytes),
      // Both forms: `filename` for anything old, `filename*` for correctness.
      // The name is derived from the version in code, never from the file on
      // disk, so what an agent saves is the same string whatever the operator
      // happened to call it in `/var/lib`.
      "Content-Disposition": `attachment; filename="${release.fileName}"; filename*=UTF-8''${encodeURIComponent(release.fileName)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
