import { LeadsProvider } from "@/components/LeadsProvider";
import MeetingsPanel from "@/components/MeetingsPanel";
import { requireUser } from "@/lib/authz";
import { listMeetingLeads } from "@/lib/leadDb";
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
 * Membership of the agenda is *derived* from the leads themselves
 * (`lib/meetings.ts`) — interested, or a date in the diary. That used to mean
 * reading the whole table here and letting the browser drop everything that was
 * not a meeting, which sent a workspace of several thousand leads to draw an
 * agenda of a dozen and made this the slowest screen in the portal for agents
 * and admins alike. `listMeetingLeads` is that same predicate as a `where`, so
 * the rows that are not on the agenda are never read, never serialised, and
 * never parsed by the browser.
 *
 * The two reads are independent — the recordings are keyed by lead id and the
 * agenda is derived from the leads — so they go together rather than in series.
 *
 * `publishStats` is off because the set below is a *filtered* one. The nav
 * bar's counters describe the whole workspace, the layout has already seeded
 * them from `leadStats`, and letting this screen recompute them from the agenda
 * alone would report "12 leads" to a portal holding several thousand.
 */
export default async function MeetingsPage() {
  const user = await requireUser("/meetings");
  const today = todayIso();
  const [recordings, leads] = await Promise.all([
    listRecordingsFor(user),
    listMeetingLeads(),
  ]);

  return (
    <LeadsProvider initialLeads={leads} serverToday={today} publishStats={false}>
      <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
        <MeetingsPanel role={user.role} initialRecordings={recordings} />
      </main>
    </LeadsProvider>
  );
}
