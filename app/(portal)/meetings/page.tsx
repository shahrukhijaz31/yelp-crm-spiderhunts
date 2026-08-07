import MeetingsPanel from "@/components/MeetingsPanel";
import { requireUser } from "@/lib/authz";
import { listRecordingsFor } from "@/lib/recordings";

/**
 * The Meetings screen.
 *
 * It gained a server half when call recordings landed. The recordings are read
 * here, on the server, with the caller resolved from their session row — so the
 * permission filter runs before anything is serialised, and an agent's HTML
 * never contains another agent's recording metadata to begin with. The panel
 * below is then free to be a straightforward client component: what it was
 * handed is what this user may see.
 *
 * `requireUser` is repeated even though the portal layout already ran it. It
 * costs nothing (the session lookup is memoised per request) and it means the
 * user object comes from a check on this page rather than from an assumption
 * about what a parent did.
 */
export default async function MeetingsPage() {
  const user = await requireUser("/meetings");
  const recordings = await listRecordingsFor(user);

  return (
    <main className="mx-auto w-full max-w-[1760px] flex-1 px-4 py-8 sm:px-7">
      <MeetingsPanel role={user.role} initialRecordings={recordings} />
    </main>
  );
}
