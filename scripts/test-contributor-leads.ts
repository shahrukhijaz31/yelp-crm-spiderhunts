/**
 * The Contributor role, end to end against the real database.
 *
 *   npm run test:contributor-leads
 *
 * Creates two contributors and an agent, adds a lead as the first contributor,
 * and checks the three things the feature promises:
 *
 *   - a contributor sees and edits only the leads they added, and somebody
 *     else's lead is "not found" to them, on every read path;
 *   - adding a lead with a first outcome records it like any other edit;
 *   - every saved edit lands in `lead_changes` with its before and after.
 *
 * Everything it creates is deleted at the end, pass or fail.
 */
import { randomBytes } from "node:crypto";

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv();

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "ok  " : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
}

async function main(): Promise<void> {
  // Imported after the env is loaded: `lib/prisma.ts` reads DATABASE_URL at
  // import time.
  const { prisma } = await import("../lib/prisma");
  const db = await import("../lib/leadDb");
  const { leadScopeFor } = await import("../lib/leadScope");
  const { parseLeadSearchParams } = await import("../lib/leadQuery");
  const { todayIso } = await import("../lib/leadUtils");

  const tag = randomBytes(4).toString("hex");
  const makeUser = (role: "CONTRIBUTOR" | "AGENT", who: string) =>
    prisma.user.create({
      data: {
        name: `Test ${who} ${tag}`,
        username: `test-${who}-${tag}`,
        email: `test-${who}-${tag}@example.invalid`,
        passwordHash: "not-a-real-hash",
        role,
      },
      select: { id: true, role: true },
    });

  const userIds: string[] = [];
  let leadId: string | null = null;

  try {
    const alice = await makeUser("CONTRIBUTOR", "alice");
    const bob = await makeUser("CONTRIBUTOR", "bob");
    const agent = await makeUser("AGENT", "agent");
    userIds.push(alice.id, bob.id, agent.id);

    const aliceScope = leadScopeFor(alice);
    const bobScope = leadScopeFor(bob);
    check("agents work the whole pool", leadScopeFor(agent) === null);

    // --- validation ---
    let refused = false;
    try {
      db.parseLeadDetails({ name: "X", phone: "12", source: "google" }, "create");
    } catch (error) {
      refused = error instanceof db.LeadEditError;
    }
    check("a phone with too few digits is refused", refused);
    refused = false;
    try {
      db.parseLeadDetails({ name: "X", phone: "4155550182", source: "facebook" }, "create");
    } catch (error) {
      refused = error instanceof db.LeadEditError;
    }
    check("a source other than Yelp or Google is refused", refused);

    // --- add, with a first outcome ---
    const details = db.parseLeadDetails(
      { name: `  Test Dental ${tag} `, phone: "(415) 555-0182", website: "", source: "google" },
      "create",
    ) as Required<ReturnType<typeof db.parseLeadDetails>>;
    const lead = await db.createLead(
      { ...details, ...db.parseLeadEdits({ status: "no_answer", notes: "Rang, no answer." }) },
      alice.id,
    );
    leadId = lead.id;
    check("the name is trimmed and an empty website is null", lead.name === `Test Dental ${tag}` && lead.website === null);
    check("a called status at creation is kept", lead.status === "no_answer");

    // --- scope on every read ---
    const today = todayIso();
    const called = parseLeadSearchParams(new URLSearchParams("work=called&pageSize=100"), today);
    const page = (scope: typeof aliceScope) => db.listLeadsPage(called, scope);
    check("the creator's worklist has it", (await page(aliceScope)).leads.some((l) => l.id === lead.id));
    check("another contributor's worklist does not", !(await page(bobScope)).leads.some((l) => l.id === lead.id));
    check("the pool has it", (await db.getLeadDetail(lead.id, null)) !== null);
    check("another contributor cannot open it", (await db.getLeadDetail(lead.id, bobScope)) === null);
    check("only the creator's leads are counted", (await db.leadStats(today, aliceScope)).total === 1);
    check("the queue badges are scoped", (await db.leadWorkCounts(aliceScope)).called === 1);
    const { queuesFor } = await import("../lib/workState");
    check("a contributor works one queue, My leads", queuesFor("CONTRIBUTOR").join() === "all");
    check("My leads counts every lead they added", (await db.leadWorkCounts(aliceScope)).all === 1);
    const mine = parseLeadSearchParams(new URLSearchParams("work=all"), today);
    check(
      "a called lead stays in My leads",
      (await db.listLeadsPage(mine, aliceScope)).leads.some((l) => l.id === lead.id),
    );
    const { isTrackedRole } = await import("../lib/access");
    check("contributors are time-tracked", isTrackedRole("CONTRIBUTOR") && !isTrackedRole("ADMIN"));
    check("another contributor counts none of them", (await db.leadStats(today, bobScope)).total === 0);
    check(
      "meetings are scoped",
      (await db.listMeetingLeads(bobScope)).every((l) => l.id !== lead.id),
    );

    // --- edits, and their history ---
    const blocked = await db.updateLeadFields(lead.id, { notes: "hijack" }, bob.id, bobScope);
    check("another contributor cannot edit it", blocked === null);

    const saved = await db.updateLeadFields(
      lead.id,
      { status: "interested", notes: "Spoke to the owner. Wants a demo.", phone: "+1 415 555 0199" },
      alice.id,
      aliceScope,
    );
    check("the creator can edit it, details included", saved?.phone === "+1 415 555 0199");

    const detail = await db.getLeadDetail(lead.id, aliceScope);
    const fields = detail?.changes.map((c) => c.field) ?? [];
    check("the lead knows who added it", detail?.addedBy?.id === alice.id);
    check("creation is in the history", fields.includes("created"));
    check(
      "the first and second call notes are both kept",
      detail?.changes.filter((c) => c.field === "notes").map((c) => c.newValue).join("|") ===
        "Spoke to the owner. Wants a demo.|Rang, no answer.",
    );
    const statusChange = detail?.changes.find((c) => c.field === "status" && c.newValue === "interested");
    check("a status change keeps its before and after", statusChange?.oldValue === "no_answer");
    check("each change names its author", detail?.changes.every((c) => c.by?.id === alice.id) ?? false);
    check("the rejected edit left no history", !detail?.changes.some((c) => c.newValue === "hijack"));

    const resaved = await db.updateLeadFields(lead.id, { status: "interested" }, alice.id, aliceScope);
    const after = await db.getLeadDetail(lead.id, aliceScope);
    check(
      "re-saving an unchanged value records nothing",
      resaved !== null && after?.changes.length === detail?.changes.length,
    );

    const calls = await prisma.leadActivity.count({ where: { leadId: lead.id, kind: "call_logged" } });
    check("every saved outcome is counted as a call", calls === 3);
  } finally {
    if (leadId) {
      await prisma.leadActivity.deleteMany({ where: { leadId } });
      await prisma.lead.delete({ where: { id: leadId } }); // cascades lead_changes
    }
    if (userIds.length > 0) {
      await prisma.leadChange.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await prisma.$disconnect();
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
