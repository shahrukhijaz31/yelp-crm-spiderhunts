import { LeadsProvider } from "@/components/LeadsProvider";
import MeetingsPanel from "@/components/MeetingsPanel";
import { requireUser } from "@/lib/authz";
import { listLeads } from "@/lib/leadDb";
import { todayIso } from "@/lib/leadUtils";
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
 *
 * The lead set is loaded here rather than by the layout, which stopped reading
 * leads when the worklist was paginated. Membership of the agenda is *derived*
 * from the leads themselves (`lib/meetings.ts`) — interested, or a date in the
 * diary — so this screen has to look at all of them to know what is on it.
 */
export default async function MeetingsPage() {
  const user = await requireUser("/meetings");
  const recordings = await listRecordingsFor(user);
  const today = todayIso();
  const leads = await listLeads();

  return (
    <LeadsProvider initialLeads={leads} serverToday={today}>
      <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
        <MeetingsPanel role={user.role} initialRecordings={recordings} />
      </main>
    </LeadsProvider>
  );
}
