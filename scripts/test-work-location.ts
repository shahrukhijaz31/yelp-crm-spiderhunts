/**
 * Office or remote, end to end against the real database.
 *
 *   npm run test:work-location
 *
 * A contributor with an open shift sends signals from the office address, then
 * from home; corrects one; moves network so the correction lapses. Checks the
 * stretches written, the status returned each time, and the summary's totals.
 * An administrator is checked to record nothing; an agent is tracked too.
 *
 * Everything it creates is deleted at the end, pass or fail.
 */
import { randomBytes } from "node:crypto";

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });
// The test sends its own addresses; the development stand-in would hide the
// "unknown address" case it checks.
delete process.env.DEV_CLIENT_IP;

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "ok  " : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
}

const OFFICE = "39.60.232.90";
const HOME = "203.0.113.50";

async function main(): Promise<void> {
  const { prisma } = await import("../lib/prisma");
  const loc = await import("../lib/workLocation");
  const { summariseLocations, isIpAddress } = await import("../lib/workLocationRules");

  // --- pure rules ---
  check("an IPv4 address is accepted", isIpAddress("39.60.232.90"));
  check("a typo is refused", !isIpAddress("39.60.232") && !isIpAddress("39.60.232.900"));
  const t = (minutes: number) => new Date(Date.UTC(2026, 9, 10, 9, minutes));
  const summary = summariseLocations(
    [
      { id: "a", location: "office", manual: false, startedAt: t(0), lastSeenAt: t(60) },
      // Overlaps the first — counted once, not twice.
      { id: "b", location: "office", manual: false, startedAt: t(30), lastSeenAt: t(90) },
      { id: "c", location: "remote", manual: false, startedAt: t(120), lastSeenAt: t(180) },
    ],
    t(0),
    t(150),
  );
  check("overlapping office stretches are counted once", summary.officeSeconds === 90 * 60);
  check("a stretch is clipped to the window", summary.remoteSeconds === 30 * 60);

  // --- against the database ---
  const tag = randomBytes(4).toString("hex");
  const users: string[] = [];
  try {
    const make = (role: "CONTRIBUTOR" | "AGENT" | "ADMIN", who: string) =>
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
    const contributor = await make("CONTRIBUTOR", "loc");
    const agent = await make("AGENT", "locagent");
    const admin = await make("ADMIN", "locadmin");
    users.push(contributor.id, agent.id, admin.id);

    check("an administrator records nothing", (await loc.recordPresence(admin, OFFICE)) === null);
    check("an agent is tracked too", (await loc.recordPresence(agent, HOME))?.location === "remote");
    check("an unknown address records nothing", (await loc.recordPresence(contributor, "unknown")) === null);

    const before = await loc.recordPresence(contributor, OFFICE);
    check("off the clock, the badge still says office", before?.location === "office");
    check(
      "off the clock, no stretch is written",
      (await prisma.workLocationSegment.count({ where: { userId: contributor.id } })) === 0,
    );

    const session = await prisma.workSession.create({
      data: { userId: contributor.id, startedAt: new Date(), lastSeenAt: new Date() },
      select: { id: true },
    });
    loc.invalidateOfficeNetworks(); // drop the throttle entry from the off-clock signal

    await loc.recordPresence(contributor, OFFICE);
    await loc.recordPresence(contributor, OFFICE); // same place, within a minute: no new row
    const home = await loc.recordPresence(contributor, HOME);
    check("moving home is detected", home?.location === "remote" && !home.manual);

    let stretches = await prisma.workLocationSegment.findMany({
      where: { workSessionId: session.id },
      orderBy: { startedAt: "asc" },
    });
    check(
      "office then home is two stretches",
      stretches.map((s) => s.location).join() === "office,remote",
    );

    // A home VPN that exits at the office: on "office", they say remote.
    await loc.recordPresence(contributor, OFFICE);
    const corrected = await loc.setLocationOverride(contributor, OFFICE, "remote");
    check("a correction is recorded as manual", corrected.location === "remote" && corrected.manual);
    check("the network is still reported as detected", corrected.detected === "office");

    // They move to a network that says remote: the correction lapses.
    loc.invalidateOfficeNetworks();
    const moved = await loc.recordPresence(contributor, HOME);
    const row = await prisma.user.findUnique({
      where: { id: contributor.id },
      select: { locationOverride: true },
    });
    check("the correction lapses when the network changes", !moved?.manual && row?.locationOverride === null);

    stretches = await prisma.workLocationSegment.findMany({
      where: { workSessionId: session.id },
      orderBy: { startedAt: "asc" },
    });
    check(
      "every change of place started a stretch",
      stretches.map((s) => `${s.location}${s.manual ? "*" : ""}`).join() ===
        "office,remote,office,remote*,remote",
    );

    // Every stretch above is a few milliseconds long. Give the first office
    // one ten minutes so the summary has something to add up.
    await prisma.workLocationSegment.update({
      where: { id: stretches[0].id },
      data: { lastSeenAt: new Date(stretches[0].startedAt.getTime() + 600_000) },
    });
    const total = await loc.locationSummary(contributor.id, {
      from: new Date(Date.now() - 3600_000),
      to: new Date(Date.now() + 3600_000),
    });
    check("the summary adds up office time", total.officeSeconds >= 600 && total.officeSeconds < 620);
    check("the summary lists the stretch", total.stretches.some((s) => s.seconds >= 600));

    const team = await loc.teamLocationTotals(
      { from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 3600_000) },
      contributor.id,
    );
    check(
      "Timesheets totals carry the same office time",
      team.length === 1 && team[0].officeSeconds === total.officeSeconds,
    );
  } finally {
    if (users.length > 0) {
      // Segments and work sessions cascade from the user.
      await prisma.user.deleteMany({ where: { id: { in: users } } });
    }
    await prisma.$disconnect();
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
