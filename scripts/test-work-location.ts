/**
 * Office or remote, end to end against the real database.
 *
 *   npm run test:work-location
 *
 * Location is chosen, not detected (the team's VPN makes office and home look
 * the same). A contributor starts a shift and is asked; chooses office; moves
 * home; a new shift asks again. Checks the status returned each time, the
 * stretches written, and every total the screens read. An administrator is
 * checked to record nothing; an agent is asked like anyone else.
 *
 * Everything it creates is deleted at the end, pass or fail.
 */
import { randomBytes } from "node:crypto";

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ quiet: true });

let failures = 0;
function check(label: string, condition: boolean): void {
  console.log(`${condition ? "ok  " : "FAIL"}  ${label}`);
  if (!condition) failures += 1;
}

const IP = "203.0.113.50";

async function main(): Promise<void> {
  const { prisma } = await import("../lib/prisma");
  const loc = await import("../lib/workLocation");
  const { summariseLocations } = await import("../lib/workLocationRules");
  const { todayWorkday } = await import("../lib/performanceRules");

  // --- pure rules ---
  const t = (minutes: number) => new Date(Date.UTC(2026, 9, 10, 9, minutes));
  const summary = summariseLocations(
    [
      { id: "a", location: "office", manual: true, startedAt: t(0), lastSeenAt: t(60) },
      // Overlaps the first — counted once, not twice.
      { id: "b", location: "office", manual: true, startedAt: t(30), lastSeenAt: t(90) },
      { id: "c", location: "remote", manual: true, startedAt: t(120), lastSeenAt: t(180) },
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

    check("an administrator records nothing", (await loc.recordPresence(admin, IP)) === null);

    const offClock = await loc.recordPresence(contributor, IP);
    check("off the clock, nothing is asked", offClock?.location === null && !offClock.needsChoice);

    let refused = false;
    try {
      await loc.setLocationChoice(contributor, IP, "office");
    } catch (error) {
      refused = error instanceof loc.WorkLocationError;
    }
    check("a choice needs a shift to belong to", refused);

    const session = await prisma.workSession.create({
      data: { userId: contributor.id, startedAt: new Date(), lastSeenAt: new Date() },
      select: { id: true },
    });

    const asked = await loc.recordPresence(contributor, IP);
    check("a new shift asks where they are", asked?.needsChoice === true && asked.location === null);
    check(
      "until they answer, nothing is recorded",
      (await prisma.workLocationSegment.count({ where: { workSessionId: session.id } })) === 0,
    );
    check("the first paint asks too", (await loc.currentLocationStatus(contributor))?.needsChoice === true);

    const office = await loc.setLocationChoice(contributor, IP, "office");
    check("choosing office records office", office.location === "office" && !office.needsChoice);
    await loc.recordPresence(contributor, IP); // within a minute: no new row
    const home = await loc.setLocationChoice(contributor, IP, "remote");
    check("moving home is recorded", home.location === "remote");

    const stretches = await prisma.workLocationSegment.findMany({
      where: { workSessionId: session.id },
      orderBy: { startedAt: "asc" },
    });
    check(
      "office then home is two stretches",
      stretches.map((s) => s.location).join() === "office,remote",
    );
    check("every stretch is marked as chosen", stretches.every((s) => s.manual));

    // A new shift asks again: yesterday's answer does not carry over.
    await prisma.workSession.update({ where: { id: session.id }, data: { endedAt: new Date() } });
    await prisma.workSession.create({
      data: { userId: contributor.id, startedAt: new Date(), lastSeenAt: new Date() },
    });
    const nextShift = await loc.currentLocationStatus(contributor);
    check("the next shift asks again", nextShift?.needsChoice === true);

    await prisma.workSession.create({
      data: { userId: agent.id, startedAt: new Date(), lastSeenAt: new Date() },
    });
    check("an agent is asked too", (await loc.recordPresence(agent, IP))?.needsChoice === true);

    // Give the office stretch ten minutes so the totals have something to add.
    await prisma.workLocationSegment.update({
      where: { id: stretches[0].id },
      data: { lastSeenAt: new Date(stretches[0].startedAt.getTime() + 600_000) },
    });
    const window = { from: new Date(Date.now() - 3600_000), to: new Date(Date.now() + 3600_000) };
    const total = await loc.locationSummary(contributor.id, window);
    check("My time adds up office time", total.officeSeconds >= 600 && total.officeSeconds < 620);

    const team = await loc.teamLocationTotals(window, contributor.id);
    check(
      "Timesheets totals carry the same office time",
      team.length === 1 && team[0].officeSeconds === total.officeSeconds,
    );

    const daily = await loc.dailyLocationTotals(todayWorkday(), 7, contributor.id);
    check("the day gauges always have seven days", daily.length === 7);
    check("the last day is today", daily[6].day === todayWorkday());
    check(
      "today's gauge carries the same office time",
      daily[6].officeSeconds === total.officeSeconds &&
        daily.slice(0, 6).every((d) => d.officeSeconds === 0),
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
