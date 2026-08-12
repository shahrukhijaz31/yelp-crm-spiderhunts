import { createHash, randomBytes } from "node:crypto";

import { PrismaPg } from "@prisma/adapter-pg";
import { config as loadEnv } from "dotenv";

import { PrismaClient } from "../lib/generated/prisma/client";
import { hashPassword } from "../lib/password";
import type {
  AgentProductivityDetail,
  AgentProductivityRow,
  MetricKey,
  ProductivityConfig,
} from "../lib/productivityRules";

/**
 * End-to-end check of agent productivity: the scoring arithmetic against real
 * rows, the permission boundaries, the configuration endpoint and the promise
 * that nothing existing was broken — against a running server and a real
 * database.
 *
 *   npm run dev                (in one terminal)
 *   npm run test:productivity  (in another)
 *
 * Written the way `test-activity.ts` and `test-screenshots.ts` were, and for the
 * same reason: this repository has no test framework, and the claims worth
 * checking are not unit-testable in any useful sense. "An agent gets a 403 from
 * the productivity API" is a claim about an HTTP route, a session cookie and a
 * role column read from Postgres — a mocked version would pass whether or not
 * the real thing works. So this speaks HTTP to the real routes and then looks in
 * the database to see what actually happened.
 *
 * It creates three throwaway agents (`prodtest-*`), an administrator, their work
 * sessions, activity intervals, leads and lead activity, and deletes all of it
 * on the way out including after a failure. It never touches an existing user,
 * lead, session or interval — and it restores the productivity configuration to
 * whatever it found, so running it against a live database leaves no trace.
 *
 * Portal sessions are inserted directly rather than signed in for: a real
 * sign-in needs a six-digit code delivered by email, which a test cannot read.
 * The token construction is copied from `lib/session.ts`, so what the routes
 * authenticate is exactly what they authenticate in production.
 */

loadEnv({ path: [".env.local", ".env"], quiet: true });

const BASE_URL = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const PASSWORD = "productivity-test-Pa55phrase";

/** Matches `SESSION_COOKIE` in `lib/access.ts`, which the server is using. */
const SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-lp_session" : "lp_session";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  log: ["error"],
});

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const createdUsers: string[] = [];
const createdLeads: string[] = [];

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function makeUser(slug: string, role: "ADMIN" | "AGENT"): Promise<string> {
  const user = await prisma.user.create({
    data: {
      username: `prodtest-${slug}`,
      email: `prodtest-${slug}@example.invalid`,
      name: `Prodtest ${slug}`,
      passwordHash: await hashPassword(PASSWORD),
      role,
    },
    select: { id: true },
  });
  createdUsers.push(user.id);
  return user.id;
}

/** Mint a portal session for a user and return the cookie header value. */
async function signIn(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();

  await prisma.session.create({
    data: {
      tokenHash: hashToken(token),
      userId,
      expiresAt: new Date(now + 60 * 60 * 1000),
      absoluteExpiresAt: new Date(now + 12 * 60 * 60 * 1000),
    },
  });

  return `${SESSION_COOKIE}=${token}`;
}

async function makeLead(name: string): Promise<string> {
  const lead = await prisma.lead.create({
    data: { name, address: "", phone: "+10000000000" },
    select: { id: true },
  });
  createdLeads.push(lead.id);
  return lead.id;
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every field any of these routes can answer with, all optional.
 *
 * One loose shape rather than a generic per call, because half of these
 * requests are *expected* to fail and a 403 body has none of the fields a 200
 * body does. A check reads the field it is testing for and gets `undefined`
 * when the route refused — which is exactly the failure it wants to report,
 * with no cast and no `any` anywhere.
 */
interface Payload {
  error?: string;
  message?: string;
  field?: string | null;
  agents?: AgentProductivityRow[];
  ranking?: Array<{ userId: string; name: string; score: number }>;
  config?: ProductivityConfig;
  row?: AgentProductivityDetail["row"];
}

interface Answer {
  status: number;
  body: Payload;
}

async function get(path: string, cookie?: string): Promise<Answer> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: cookie ? { cookie } : {},
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function putJson(path: string, cookie: string | undefined, body: unknown): Promise<Answer> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** A page, as markup. The screens are checked, not only the endpoints behind them. */
async function getPage(path: string, cookie?: string): Promise<{ status: number; html: string }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return { status: response.status, html: await response.text().catch(() => "") };
}

/** One agent's row from a report, or undefined. */
function find(answer: Answer, userId: string): AgentProductivityRow | undefined {
  return (answer.body.agents ?? []).find((row) => row.userId === userId);
}

/** One component of a score, by key. */
function byKey(row: AgentProductivityRow | undefined, key: MetricKey) {
  return row?.productivity.components.find((component) => component.key === key);
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

const DEFAULTS = {
  callsTarget: 50,
  leadsTarget: 40,
  meetingsTarget: 5,
  followUpsTarget: 30,
  activityTarget: 80,
  callsWeight: 30,
  leadsWeight: 25,
  meetingsWeight: 25,
  activityWeight: 10,
  followUpsWeight: 10,
};

/** The configuration as it was before this run, so it can be put back. */
let originalConfig: Record<string, number> | null = null;
let configWasDefault = true;

function isoDay(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  console.log(`Agent productivity — end-to-end against ${BASE_URL}\n`);

  /* --- a window inside today --------------------------------------------- */
  // Every fixture has to sit inside the server's *local* today, because that is
  // what the "Today" preset resolves to. Anchored to local midnight rather than
  // to `now - 3h`, which would fall into yesterday for a run just after
  // midnight and quietly make every count zero.
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const shiftStart = new Date(Math.max(dayStart.getTime() + 60_000, Date.now() - 3 * 3600_000));
  const shiftEnd = new Date(Math.min(Date.now() - 60_000, shiftStart.getTime() + 2 * 3600_000));
  const shiftSeconds = Math.round((shiftEnd.getTime() - shiftStart.getTime()) / 1000);

  if (shiftSeconds < 600) {
    console.log(
      "  NOTE  the server's local day started less than ~12 minutes ago; the fixture window is short.",
    );
  }

  /* --- accounts ----------------------------------------------------------- */
  section("Fixtures");

  const [aliceId, bobId, idleId, adminId] = await Promise.all([
    makeUser("alice", "AGENT"),
    makeUser("bob", "AGENT"),
    makeUser("idle", "AGENT"),
    makeUser("admin", "ADMIN"),
  ]);

  const [aliceCookie, adminCookie] = await Promise.all([signIn(aliceId), signIn(adminId)]);

  // Alice: a finished shift today, with activity observed inside it.
  const aliceShift = await prisma.workSession.create({
    data: {
      userId: aliceId,
      startedAt: shiftStart,
      lastSeenAt: shiftEnd,
      endedAt: shiftEnd,
      durationSeconds: shiftSeconds,
      endedReason: "logout",
    },
    select: { id: true },
  });

  // Two minutes of intervals: 80% and 100%, which is a duration-weighted 90%.
  await prisma.activityInterval.createMany({
    data: [80, 100].map((percentage, index) => ({
      userId: aliceId,
      workSessionId: aliceShift.id,
      startedAt: new Date(shiftStart.getTime() + (index + 1) * 60_000),
      endedAt: new Date(shiftStart.getTime() + (index + 2) * 60_000),
      durationSeconds: 60,
      keyboardActivityCount: percentage,
      mouseActivityCount: 20,
      activityPercentage: percentage,
      clientKey: `prodtest-${index}-${randomBytes(4).toString("hex")}`,
    })),
  });

  // Bob: the same shape of shift, and no activity data at all — the case the
  // score must not treat as 0% activity.
  await prisma.workSession.create({
    data: {
      userId: bobId,
      startedAt: shiftStart,
      lastSeenAt: shiftEnd,
      endedAt: shiftEnd,
      durationSeconds: shiftSeconds,
      endedReason: "logout",
    },
    select: { id: true },
  });

  // `idle` gets nothing at all: no shift, no work. An agent who cannot be
  // scored, which must read as "no score" and never as 0%.

  const [leadOne, leadTwo, leadThree, leadFour] = await Promise.all([
    makeLead("Prodtest Lead One"),
    makeLead("Prodtest Lead Two"),
    makeLead("Prodtest Lead Three"),
    makeLead("Prodtest Lead Four"),
  ]);

  // Alice's work. Explicit, distinct timestamps: the follow-up rule is "a call
  // on a lead that already had an earlier call", and rows written in the same
  // millisecond would satisfy neither side of a strict comparison.
  const at = (minutes: number) => new Date(shiftStart.getTime() + minutes * 60_000);

  await prisma.leadActivity.createMany({
    data: [
      { leadId: leadOne, userId: aliceId, kind: "call_logged", status: "no_answer", createdAt: at(1) },
      // The second call on lead one — this is the follow-up.
      { leadId: leadOne, userId: aliceId, kind: "call_logged", status: "interested", createdAt: at(2) },
      { leadId: leadTwo, userId: aliceId, kind: "call_logged", status: "interested", createdAt: at(3) },
      { leadId: leadThree, userId: aliceId, kind: "call_logged", status: "voicemail", createdAt: at(4) },
      { leadId: leadTwo, userId: aliceId, kind: "meeting_booked", createdAt: at(5) },
      { leadId: leadOne, userId: aliceId, kind: "meeting_completed", createdAt: at(6) },
      // Scheduled, not completed — reported but deliberately not scored.
      { leadId: leadThree, userId: aliceId, kind: "callback_scheduled", createdAt: at(7) },
    ],
  });

  // Bob: one call, on a lead nobody has called before.
  await prisma.leadActivity.createMany({
    data: [
      { leadId: leadFour, userId: bobId, kind: "call_logged", status: "no_answer", createdAt: at(1) },
    ],
  });

  // The administrator does work too, and must still never be scored.
  await prisma.workSession.create({
    data: {
      userId: adminId,
      startedAt: shiftStart,
      lastSeenAt: shiftEnd,
      endedAt: shiftEnd,
      durationSeconds: shiftSeconds,
      endedReason: "logout",
    },
  });
  await prisma.leadActivity.createMany({
    data: [
      { leadId: leadFour, userId: adminId, kind: "call_logged", status: "interested", createdAt: at(8) },
      { leadId: leadFour, userId: adminId, kind: "meeting_booked", createdAt: at(9) },
    ],
  });

  check("fixtures created", true);

  // Remember the configuration so it can be restored, whatever this run does.
  const existing = await prisma.productivitySettings.findUnique({ where: { id: "default" } });
  configWasDefault = existing === null;
  if (existing) {
    originalConfig = {
      callsTarget: existing.callsTarget,
      leadsTarget: existing.leadsTarget,
      meetingsTarget: existing.meetingsTarget,
      followUpsTarget: existing.followUpsTarget,
      activityTarget: existing.activityTarget,
      callsWeight: existing.callsWeight,
      leadsWeight: existing.leadsWeight,
      meetingsWeight: existing.meetingsWeight,
      activityWeight: existing.activityWeight,
      followUpsWeight: existing.followUpsWeight,
    };
  }

  // Start from a known configuration so the arithmetic below is checkable.
  await putJson("/api/reports/productivity/config", adminCookie, DEFAULTS);

  /* --- permissions -------------------------------------------------------- */
  section("Only administrators can reach productivity");

  const agentTeam = await get("/api/reports/productivity", aliceCookie);
  check("an agent gets 403 from the team endpoint", agentTeam.status === 403, `got ${agentTeam.status}`);

  const agentOwn = await get(`/api/reports/productivity/${aliceId}`, aliceCookie);
  check(
    "an agent gets 403 asking for their own score",
    agentOwn.status === 403,
    `got ${agentOwn.status}`,
  );

  const agentOther = await get(`/api/reports/productivity/${bobId}`, aliceCookie);
  check(
    "an agent gets 403 asking for a colleague's score",
    agentOther.status === 403,
    `got ${agentOther.status}`,
  );

  const agentConfig = await get("/api/reports/productivity/config", aliceCookie);
  check(
    "an agent gets 403 from the configuration endpoint",
    agentConfig.status === 403,
    `got ${agentConfig.status}`,
  );

  const agentWrite = await putJson("/api/reports/productivity/config", aliceCookie, DEFAULTS);
  check(
    "an agent cannot change the configuration",
    agentWrite.status === 403,
    `got ${agentWrite.status}`,
  );

  const anonymous = await get("/api/reports/productivity");
  check("a signed-out caller gets 401", anonymous.status === 401, `got ${anonymous.status}`);

  const anonymousConfig = await putJson("/api/reports/productivity/config", undefined, DEFAULTS);
  check(
    "a signed-out caller cannot change the configuration",
    anonymousConfig.status === 401,
    `got ${anonymousConfig.status}`,
  );

  check(
    "the agent's own performance endpoint still works (unchanged)",
    (await get("/api/performance/me", aliceCookie)).status === 200,
  );
  check(
    "the agent's own time-tracking endpoint still works (unchanged)",
    (await get("/api/time-tracking/me", aliceCookie)).status === 200,
  );

  /* --- the numbers -------------------------------------------------------- */
  section("Productivity is calculated from real data");

  const report = await get("/api/reports/productivity?range=today", adminCookie);
  check("an admin can read the team report", report.status === 200, `got ${report.status}`);

  const rows = report.body.agents ?? [];
  const alice = find(report, aliceId);
  const bob = find(report, bobId);
  const idle = find(report, idleId);

  check("the agent appears in the report", Boolean(alice));
  check(
    "calls are counted from lead activity",
    alice?.calls === 4,
    `got ${alice?.calls}`,
  );
  check(
    "leads processed is a distinct count, not a call count",
    alice?.leadsProcessed === 3,
    `got ${alice?.leadsProcessed}`,
  );
  check("meetings booked are counted", alice?.meetingsBooked === 1, `got ${alice?.meetingsBooked}`);
  check(
    "a repeat call on a called lead is a follow-up",
    alice?.followUpCalls === 1,
    `got ${alice?.followUpCalls}`,
  );
  check(
    "follow-ups are repeat calls plus completed meetings",
    alice?.followUps === 2,
    `got ${alice?.followUps}`,
  );
  check(
    "a scheduled callback is reported but not counted as a follow-up",
    alice?.callbacksScheduled === 1 && alice?.followUps === 2,
    `callbacks ${alice?.callbacksScheduled}, follow-ups ${alice?.followUps}`,
  );
  check(
    "tracked time comes from the work session",
    Math.abs((alice?.trackedSeconds ?? 0) - shiftSeconds) <= 2,
    `got ${alice?.trackedSeconds}, expected ~${shiftSeconds}`,
  );

  /* --- activity stays separate -------------------------------------------- */
  section("Activity is separate from productivity");

  check(
    "the existing activity figure is reported unchanged",
    alice?.activityPercentage === 90,
    `got ${alice?.activityPercentage}`,
  );
  check(
    "productivity is not the activity percentage",
    alice?.productivity?.score !== alice?.activityPercentage,
    `both ${alice?.productivity?.score}`,
  );
  check(
    "the output score is reported beside activity",
    typeof alice?.productivity?.outputScore === "number",
  );

  /* --- the formula --------------------------------------------------------- */
  section("The score follows the configured weights");

  // 4/50 = 8%, 3/40 = 8%, 1/5 = 20%, 90/80 capped at 100%, 2/30 = 7%
  // 8×30 + 8×25 + 20×25 + 100×10 + 7×10 = 2010 / 100 = 20.1
  check("the calls component scores against its target", byKey(alice, "calls")?.score === 8);
  check("the leads component scores against its target", byKey(alice, "leads")?.score === 8);
  check("the meetings component scores against its target", byKey(alice, "meetings")?.score === 20);
  check("the follow-ups component scores against its target", byKey(alice, "followUps")?.score === 7);
  check(
    "an activity figure above its target is capped at 100%",
    byKey(alice, "activity")?.score === 100,
    `got ${byKey(alice, "activity")?.score}`,
  );
  check(
    "the overall score is the weighted sum of the components",
    alice?.productivity?.score === 20.1,
    `got ${alice?.productivity?.score}`,
  );
  check(
    "each component reports the weight it carries",
    byKey(alice, "calls")?.weight === 30 && byKey(alice, "activity")?.weight === 10,
  );

  /* --- missing data -------------------------------------------------------- */
  section("Missing data is missing, not zero");

  check(
    "an agent with no activity data has no activity percentage",
    bob?.activityPercentage === null,
    `got ${bob?.activityPercentage}`,
  );
  check(
    "…and the activity component is unavailable rather than scored 0%",
    byKey(bob, "activity")?.available === false && byKey(bob, "activity")?.score === null,
  );
  check(
    "…with its weight redistributed over the metrics that could be measured",
    // (2×30 + 3×25) / 90 = 1.5
    bob?.productivity?.score === 1.5,
    `got ${bob?.productivity?.score}`,
  );
  check(
    "…and the applied weights of the scored metrics total 100%",
    Math.abs(
      (bob?.productivity.components ?? [])
        .filter((component) => component.available)
        .reduce((sum, component) => sum + component.appliedWeight, 0) - 100,
    ) < 0.5,
  );
  check(
    "a real zero is still a zero",
    byKey(bob, "meetings")?.score === 0 && byKey(bob, "meetings")?.available === true,
  );
  check(
    "an agent who was never on the clock has no score at all",
    idle?.productivity?.score === null && idle?.trackedSeconds === 0,
    `got ${idle?.productivity?.score}`,
  );
  check(
    "…and is excluded from the ranking rather than ranked last with 0%",
    !(report.body.ranking ?? []).some((entry) => entry.userId === idleId),
  );

  /* --- administrators ------------------------------------------------------ */
  section("Administrators are never scored");

  check(
    "no administrator appears in the team report",
    !rows.some((row) => row.userId === adminId),
  );
  check(
    "no administrator appears in the ranking",
    !(report.body.ranking ?? []).some((entry) => entry.userId === adminId),
  );

  const adminDetail = await get(`/api/reports/productivity/${adminId}`, adminCookie);
  check(
    "asking for an administrator's productivity is a 404",
    adminDetail.status === 404,
    `got ${adminDetail.status}`,
  );

  const adminRows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*) AS count FROM productivity_settings`,
  );
  check(
    "the configuration is a single row",
    Number(adminRows[0]?.count ?? 0) === 1,
    `got ${adminRows[0]?.count}`,
  );

  /* --- the detail view ----------------------------------------------------- */
  section("The agent detail view shows its working");

  const detail = await get(`/api/reports/productivity/${aliceId}?range=today`, adminCookie);
  check("an admin can read one agent's detail", detail.status === 200);
  check(
    "the detail agrees with the row on the dashboard",
    detail.body.row?.productivity?.score === alice?.productivity?.score,
  );
  check(
    "it carries all five components with targets and weights",
    detail.body.row?.productivity?.components?.length === 5,
  );
  check(
    "it reports inactive time as tracked minus active",
    detail.body.row !== undefined &&
      detail.body.row.idleSeconds ===
        detail.body.row.trackedSeconds - detail.body.row.activeSeconds,
  );
  check(
    "it names the configuration the score was calculated with",
    detail.body.config?.callsTarget === 50 && detail.body.config?.callsWeight === 30,
  );
  check(
    "a detail request for an id that names nobody is a 404",
    (await get("/api/reports/productivity/nosuchagentid", adminCookie)).status === 404,
  );

  /* --- time periods -------------------------------------------------------- */
  section("Every time period works");

  const week = await get("/api/reports/productivity?range=last7", adminCookie);
  const month = await get("/api/reports/productivity?range=last30", adminCookie);
  const yesterday = isoDay(new Date(Date.now() - 86_400_000));
  const custom = await get(
    `/api/reports/productivity?range=custom&from=${yesterday}&to=${yesterday}`,
    adminCookie,
  );
  const customToday = await get(
    `/api/reports/productivity?range=custom&from=${isoDay(new Date())}&to=${isoDay(new Date())}`,
    adminCookie,
  );

  check("this week is calculated", week.status === 200 && find(week, aliceId)?.calls === 4);
  check("this month is calculated", month.status === 200 && find(month, aliceId)?.calls === 4);
  check(
    "a multi-day window scales the expectation by worked days, not by days elapsed",
    // One worked day either way, so the score is the same as today's.
    find(week, aliceId)?.productivity?.workedDays === 1 &&
      find(week, aliceId)?.productivity?.score === 20.1,
    `worked ${find(week, aliceId)?.productivity?.workedDays}, score ${find(week, aliceId)?.productivity?.score}`,
  );
  check("a custom range is calculated", customToday.status === 200 && find(customToday, aliceId)?.calls === 4);
  check(
    "a custom range with nothing in it reports zero and no score, not a fake one",
    custom.status === 200 &&
      find(custom, aliceId)?.calls === 0 &&
      find(custom, aliceId)?.productivity?.score === null,
    `calls ${find(custom, aliceId)?.calls}, score ${find(custom, aliceId)?.productivity?.score}`,
  );

  /* --- filters and sorting -------------------------------------------------- */
  section("Filtering and sorting happen on the server");

  const oneAgent = await get(`/api/reports/productivity?range=today&agent=${aliceId}`, adminCookie);
  check(
    "filtering by agent narrows the report",
    oneAgent.body.agents?.length === 1 && oneAgent.body.agents[0].userId === aliceId,
  );

  const highActivity = await get(
    "/api/reports/productivity?range=today&minActivity=95",
    adminCookie,
  );
  check(
    "an activity floor excludes agents below it",
    !(highActivity.body.agents ?? []).some((row) => row.userId === aliceId),
  );
  check(
    "…and excludes agents with no activity data rather than failing them at 0%",
    !(highActivity.body.agents ?? []).some((row) => row.userId === bobId),
  );

  const band = await get(
    "/api/reports/productivity?range=today&minProductivity=10&maxProductivity=30",
    adminCookie,
  );
  check(
    "a productivity range keeps only the agents inside it",
    (band.body.agents ?? []).some((row) => row.userId === aliceId) &&
      !(band.body.agents ?? []).some((row) => row.userId === bobId),
  );

  const byCalls = await get(
    "/api/reports/productivity?range=today&sort=calls&direction=desc",
    adminCookie,
  );
  const callOrder = (byCalls.body.agents ?? []).map((row) => row.calls);
  check(
    "sorting by calls is applied server-side",
    callOrder.every((value, index) => index === 0 || callOrder[index - 1] >= value),
  );
  check(
    "an unscored agent sorts last whichever way productivity is sorted",
    (await get("/api/reports/productivity?range=today&sort=productivity&direction=asc", adminCookie)).body
      .agents?.at(-1)?.productivity?.score === null,
  );
  check(
    "the ranking is over every agent, not only the filtered ones",
    (oneAgent.body.ranking ?? []).length === (report.body.ranking ?? []).length,
  );

  /* --- configuration -------------------------------------------------------- */
  section("The configuration is validated and is what the score uses");

  const badWeights = await putJson("/api/reports/productivity/config", adminCookie, {
    ...DEFAULTS,
    callsWeight: 40,
  });
  check(
    "weights that do not total 100 are refused",
    badWeights.status === 422 && badWeights.body.error === "weights_must_total_100",
    `got ${badWeights.status} ${badWeights.body.error}`,
  );

  const zeroTarget = await putJson("/api/reports/productivity/config", adminCookie, {
    ...DEFAULTS,
    callsTarget: 0,
  });
  check(
    "a target of zero is refused",
    zeroTarget.status === 422 && zeroTarget.body.field === "callsTarget",
    `got ${zeroTarget.status} ${zeroTarget.body.field}`,
  );

  const negativeTarget = await putJson("/api/reports/productivity/config", adminCookie, {
    ...DEFAULTS,
    meetingsTarget: -5,
  });
  check("a negative target is refused", negativeTarget.status === 422);

  const silly = await putJson("/api/reports/productivity/config", adminCookie, {
    ...DEFAULTS,
    activityTarget: 140,
  });
  check("an activity target above 100% is refused", silly.status === 422);

  const fractional = await putJson("/api/reports/productivity/config", adminCookie, {
    ...DEFAULTS,
    leadsTarget: 12.5,
  });
  check("a fractional target is refused", fractional.status === 422);

  const unchanged = await get("/api/reports/productivity/config", adminCookie);
  check(
    "a refused change writes nothing",
    unchanged.body.config?.callsWeight === 30 && unchanged.body.config?.callsTarget === 50,
  );

  // A configuration under which Alice's four calls are twice the target, which
  // is what the cap has to hold at 100%.
  const reweighted = await putJson("/api/reports/productivity/config", adminCookie, {
    ...DEFAULTS,
    callsTarget: 2,
    callsWeight: 100,
    leadsWeight: 0,
    meetingsWeight: 0,
    activityWeight: 0,
    followUpsWeight: 0,
  });
  check("a valid change is accepted", reweighted.status === 200, `got ${reweighted.status}`);
  check(
    "it records who made it",
    reweighted.body.config?.updatedByName === "Prodtest admin" &&
      reweighted.body.config?.isDefault === false,
  );

  const capped = await get("/api/reports/productivity?range=today", adminCookie);
  const cappedAlice = find(capped, aliceId);
  check(
    "beating a target does not score above 100%",
    byKey(cappedAlice, "calls")?.score === 100,
    `got ${byKey(cappedAlice, "calls")?.score}`,
  );
  check(
    "…and the overall score is capped with it, not doubled",
    cappedAlice?.productivity?.score === 100,
    `got ${cappedAlice?.productivity?.score}`,
  );
  check(
    "the new weights are what the score used",
    byKey(cappedAlice, "calls")?.weight === 100,
  );

  /* --- the screens ------------------------------------------------------------ */
  section("The screens render, and refuse the right people");

  const board = await getPage("/reports/productivity", adminCookie);
  check(
    "an admin gets the productivity dashboard",
    board.status === 200 && board.html.includes("Agent productivity"),
    `got ${board.status}`,
  );
  check("…rendered with real rows, not a skeleton", board.html.includes("Prodtest alice"));

  const agentBoard = await getPage("/reports/productivity", aliceCookie);
  check(
    "an agent is turned away from the dashboard",
    // The marker is a sentence only the dashboard contains. Deliberately not
    // the agent's own name: the shell prints that in the top bar, so it is on
    // the Access Denied screen too and would pass this check while the agent
    // was in fact reading the board.
    !agentBoard.html.includes("Work produced against the targets"),
    `got ${agentBoard.status}`,
  );

  const detailPage = await getPage(`/reports/productivity/${aliceId}`, adminCookie);
  check(
    "an admin gets the agent detail screen",
    detailPage.status === 200 && detailPage.html.includes("How this score was calculated"),
    `got ${detailPage.status}`,
  );

  const adminPage = await getPage(`/reports/productivity/${adminId}`, adminCookie);
  check(
    "the detail screen 404s for an administrator",
    adminPage.status === 404,
    `got ${adminPage.status}`,
  );

  const settings = await getPage("/settings", adminCookie);
  check(
    "the settings screen carries the productivity configuration",
    settings.status === 200 && settings.html.includes("Agent productivity"),
    `got ${settings.status}`,
  );

  const agentSettings = await getPage("/settings", aliceCookie);
  check(
    "an agent is turned away from settings",
    !agentSettings.html.includes("Restore defaults"),
    `got ${agentSettings.status}`,
  );

  /* --- nothing existing is broken -------------------------------------------- */
  section("Everything that existed still works");

  for (const [label, path] of [
    ["the team performance report", "/api/reports/team?range=today"],
    ["the time tracking dashboard", "/api/reports/time"],
    ["the timesheet", "/api/reports/timesheets?range=last7"],
    ["one employee's time record", `/api/reports/time/${aliceId}?range=today`],
    ["the time adjustment audit trail", "/api/time-adjustments"],
    ["the user list", "/api/users"],
  ] as const) {
    check(`${label} still answers`, (await get(path, adminCookie)).status === 200);
  }

  const leads = await get("/api/leads?page=1", aliceCookie);
  check("an agent can still read their worklist", leads.status === 200);
  // A single lead, which is what the lead detail and the meetings screen read.
  // There is no `/api/meetings` endpoint and there never was: the agenda is
  // derived from the leads themselves (`lib/meetings.ts`), which is exactly the
  // fact this check exists to keep true.
  check(
    "an agent can still read one lead",
    (await get(`/api/leads/${leadOne}`, aliceCookie)).status === 200,
  );
  check(
    "the existing activity figures are unchanged by any of this",
    (
      await prisma.activityInterval.findMany({
        where: { userId: aliceId },
        select: { activityPercentage: true },
        orderBy: { startedAt: "asc" },
      })
    )
      .map((row) => row.activityPercentage)
      .join(",") === "80,100",
  );
  check(
    "the work session was neither moved nor re-timed",
    (await prisma.workSession.findUnique({ where: { id: aliceShift.id } }))?.durationSeconds ===
      shiftSeconds,
  );
  check(
    "no productivity rows were written against any agent",
    (await prisma.leadActivity.count({ where: { userId: aliceId } })) === 7,
  );

  /* --- scale ------------------------------------------------------------------ */
  section("It holds up on a large dataset");

  // Two thousand more calls for Bob, which is a busy month for one agent and is
  // enough to catch a per-row query or a browser-side count.
  const bulk = Array.from({ length: 2000 }, (_, index) => ({
    leadId: index % 2 === 0 ? leadFour : leadThree,
    userId: bobId,
    kind: "call_logged" as const,
    status: "no_answer" as const,
    createdAt: new Date(shiftStart.getTime() + 8 * 60_000 + index * 100),
  }));
  await prisma.leadActivity.createMany({ data: bulk });

  const startedAt = Date.now();
  const big = await get("/api/reports/productivity?range=today", adminCookie);
  const elapsed = Date.now() - startedAt;

  const bigBob = find(big, bobId);
  check(
    "two thousand extra call rows are counted correctly",
    bigBob?.calls === 2001,
    `got ${bigBob?.calls}`,
  );
  check(
    "…including the follow-up detection over all of them",
    // Lead four had one call from Bob and one from the admin before the bulk;
    // lead three had one from Alice. Every bulk row is therefore a follow-up.
    bigBob?.followUpCalls === 2000,
    `got ${bigBob?.followUpCalls}`,
  );
  check(`…and the report still returns quickly (${elapsed}ms)`, elapsed < 5000, `${elapsed}ms`);
  check(
    "the response is one row per agent, never one per lead or per call",
    (big.body.agents ?? []).length <= (await prisma.user.count({ where: { role: "AGENT" } })),
  );
  check(
    "no raw lead, interval or screenshot data is in the payload",
    JSON.stringify(big.body).length < 200_000 &&
      !("leads" in big.body) &&
      !("intervals" in big.body) &&
      !("screenshots" in big.body),
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

/**
 * Remove everything this run created, and put the configuration back.
 *
 * Ordered so foreign keys are satisfied without relying on cascade rules being
 * what they are today. The configuration is restored *before* the accounts go,
 * because its `updated_by` points at the throwaway administrator — `SetNull`
 * would otherwise leave a live row quietly attributed to nobody.
 */
async function cleanup(): Promise<void> {
  if (originalConfig) {
    await prisma.productivitySettings
      .update({ where: { id: "default" }, data: { ...originalConfig, updatedById: null } })
      .catch(() => {});
  } else if (configWasDefault) {
    // There was no row before this run, so there must be none after it.
    await prisma.productivitySettings.deleteMany({ where: { id: "default" } }).catch(() => {});
  }

  if (createdUsers.length > 0) {
    await prisma.leadActivity.deleteMany({ where: { userId: { in: createdUsers } } }).catch(() => {});
    await prisma.activityInterval
      .deleteMany({ where: { userId: { in: createdUsers } } })
      .catch(() => {});
    await prisma.workSession.deleteMany({ where: { userId: { in: createdUsers } } }).catch(() => {});
    await prisma.session.deleteMany({ where: { userId: { in: createdUsers } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } }).catch(() => {});
  }

  if (createdLeads.length > 0) {
    await prisma.leadActivity.deleteMany({ where: { leadId: { in: createdLeads } } }).catch(() => {});
    await prisma.lead.deleteMany({ where: { id: { in: createdLeads } } }).catch(() => {});
  }
}

main()
  .catch((error) => {
    console.error("\nThe run failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    await prisma.$disconnect();
  });
