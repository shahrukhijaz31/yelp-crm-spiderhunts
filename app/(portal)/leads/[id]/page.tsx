import { notFound } from "next/navigation";

import AccessDenied from "@/components/AccessDenied";
import LeadWorkspace from "@/components/LeadWorkspace";
import { requireModule } from "@/lib/authz";
import { getLeadDetail, nextLeadId } from "@/lib/leadDb";
import { leadsListHref, leadWorkspaceHref, readLeadPosition } from "@/lib/leadLink";
import { parseLeadSearchParams } from "@/lib/leadQuery";
import { todayIso } from "@/lib/leadUtils";
import { getRecordingSummaryFor } from "@/lib/recordings";

/**
 * One lead, on its own URL, in its own browser tab.
 *
 * **The URL is the whole feature.** A lead is opened from the worklist with an
 * ordinary link and an ordinary target, which is why Ctrl-click, middle-click
 * and "open in new tab" all behave the way the browser says they should — none
 * of that is implemented here, it is what you get for not implementing an
 * in-app tab strip instead. The consequence is that this route has to stand on
 * its own: pasted, bookmarked, reloaded or arrived at from nowhere, it renders.
 *
 * So everything is read from the id and the query string, and nothing is
 * assumed to have been handed over by the screen that linked here.
 *
 * The guard runs before any lead is read, exactly as the portal layout and the
 * worklist do it — both lookups are memoised per request, so repeating it costs
 * nothing and means no lead reaches the wire on the strength of an assumption
 * about what a parent component did. Both roles: working a lead is the agent's
 * job, and there is nothing on this page an agent with the Leads module may not
 * see. What they may do with the *recording* is decided a layer down, by
 * `getRecordingSummaryFor`, against the row rather than the route.
 *
 * `requireModule("leads")` rather than `requireUser()`: an account an
 * administrator has taken off the worklist must not reach a lead by pasting its
 * URL either, and this is the page that URL names. No redirect here, unlike the
 * worklist — somebody who followed a link to a specific lead is refused rather
 * than quietly moved somewhere else.
 *
 * The search params carry the list this lead was opened from — the queue, the
 * tab, the filters, the sort, the page and the lead's ordinal within it. They
 * are parsed by `parseLeadSearchParams`, the same validator `GET /api/leads`
 * runs, so a hand-edited URL narrows the Next lead query to something this app
 * offers or to nothing at all. Their only job is to answer "what comes after
 * this one" and "where do I go back to"; the lead itself is read by id and does
 * not depend on any of them.
 */
export default async function LeadPage(props: PageProps<"/leads/[id]">) {
  const { user, access, allowed } = await requireModule("leads");
  if (!allowed) {
    return access.demoWebsites ? (
      <AccessDenied homeHref="/demo-websites" homeLabel="Back to Demo Websites" />
    ) : (
      <AccessDenied />
    );
  }

  const { id } = await props.params;
  const params = toSearchParams(await props.searchParams);

  const query = parseLeadSearchParams(params, todayIso());
  const position = readLeadPosition(params.get("pos"));

  const detail = await getLeadDetail(id);
  // A lead that has been deleted, or an id that never named one. `notFound`
  // rather than an empty workspace: the tab was opened for a specific lead and
  // there is nothing here to work.
  if (!detail) notFound();

  const [recording, nextId] = await Promise.all([
    getRecordingSummaryFor(id, user),
    nextLeadId(query, id, position),
  ]);

  return (
    <LeadWorkspace
      // Remounts when the agent moves to the next lead. Without it React would
      // reuse this component across the param change and the new lead would
      // arrive wearing the previous one's draft.
      key={detail.lead.id}
      detail={detail}
      initialRecording={recording}
      serverToday={query.today}
      nav={{
        variant: "page",
        backHref: leadsListHref(query),
        nextHref: nextId
          ? // The next lead inherits the same list, one ordinal further along.
            leadWorkspaceHref(nextId, query, position === null ? null : position + 1)
          : null,
      }}
    />
  );
}

/**
 * Next hands `searchParams` over as a plain object of strings and arrays; every
 * validator in this app reads a `URLSearchParams`. Repeated keys are appended
 * rather than flattened, because `?status=a&status=b` is two statuses and the
 * filter vocabulary says so.
 */
function toSearchParams(
  input: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const entry of value) params.append(key, entry);
    else params.append(key, value);
  }
  return params;
}
