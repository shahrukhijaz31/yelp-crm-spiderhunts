/**
 * Agent productivity: what each metric means, what it is measured against, and
 * how the five of them become one number.
 *
 * **No Prisma here**, the same split `lib/performanceRules.ts` keeps from
 * `lib/performance.ts` and `lib/activityRules.ts` from `lib/timeTracking.ts`:
 * the configuration screen and the dashboard are client components, so the
 * shapes and the arithmetic have to live somewhere a browser bundle can import.
 * Everything below is pure — input in, a value or a typed error out.
 *
 * ===========================================================================
 * Productivity is not activity
 * ===========================================================================
 * Activity is the existing keyboard/mouse figure from the desktop Monitor
 * (`lib/activityRules.ts`), it is unchanged by this file, and it is *one
 * component out of five* here, carrying the smallest weight of any of them.
 * The other four are counts of work an agent actually saved. A quiet agent who
 * calls fifty leads and books five meetings scores well; a busy keyboard with
 * nothing behind it does not. That is the point, and it is why the two figures
 * are reported side by side everywhere rather than one being renamed the other.
 *
 * Nothing here reads a screenshot, and there is no second, hidden score.
 *
 * ===========================================================================
 * The exact definition of each metric
 * ===========================================================================
 * Every one is counted from `lead_activities` — the existing append-only log of
 * what an agent did to a lead, written from the one endpoint that persists an
 * agent's work (`lib/leadActivity.ts`). Nothing is inferred from a lead's
 * current state, because that is overwritten in place and carries no actor.
 *
 *   CALLS            `call_logged` rows. One per call outcome an agent saved,
 *                    which is the same act that stamps `leads.first_called_at`.
 *                    A notes-only save is not a call, and correcting a lead back
 *                    to "not called" is not a call.
 *
 *   LEADS PROCESSED  `count(DISTINCT lead_id)` over those same rows. Lower than
 *                    CALLS whenever a lead was worked more than once in the
 *                    window. Deliberately not "leads opened": opening a lead
 *                    reaches no write and must not manufacture a statistic.
 *
 *   MEETINGS BOOKED  `meeting_booked` rows — a diary date *with a time on it*,
 *                    which is what the Book meeting dialog sends. In this app a
 *                    meeting is a callback with a time (`lib/meetings.ts`);
 *                    there is no meetings table and none was invented.
 *
 *   FOLLOW-UPS       Follow-ups **completed**, which is two things and not the
 *                    number of follow-ups *scheduled*:
 *                      - a `call_logged` row against a lead that already had an
 *                        earlier `call_logged` row — the agent went back to a
 *                        lead somebody had already called, which is what
 *                        completing a follow-up is; plus
 *                      - a `meeting_completed` row — a booked meeting marked
 *                        done.
 *                    `callback_scheduled` is deliberately *not* counted. It
 *                    records a promise rather than work performed, and counting
 *                    it would let an agent raise their score by typing dates
 *                    into a diary they never return to. It is still shown on the
 *                    agent detail screen as its own figure.
 *
 *   ACTIVITY         The existing duration-weighted mean of
 *                    `activity_intervals.activity_percentage` over the window,
 *                    unchanged and recomputed by nothing here. Null — not zero —
 *                    when no interval was observed; see below.
 *
 * ===========================================================================
 * What the targets are measured per
 * ===========================================================================
 * Targets are **per agent per worked day**, and a worked day is a local
 * calendar day in the window on which the agent had a work session. So the
 * expectation over a window is `target × workedDays`, not `target × days in the
 * window`: an agent who was on the clock for three days of a seven-day period is
 * measured against three days of work, because a day off is not a day they
 * failed to make fifty calls on.
 *
 * The limitation this accepts, stated rather than hidden: a day is a day
 * whether the agent worked one hour of it or nine. Prorating by tracked hours
 * would need an agreed length for a working day, which is a number nobody has
 * set and which this application has no business inventing. Tracked hours are on
 * every screen beside the score, so a short day is visible to the person reading
 * it.
 *
 * ===========================================================================
 * Missing data is missing, not zero
 * ===========================================================================
 * Two different absences, handled differently and both visibly:
 *
 *   - **No activity data** (the Monitor was never running). The activity
 *     component is marked unavailable and its weight is redistributed over the
 *     components that *can* be scored, so the remaining weights still total the
 *     configured whole. Scoring it as 0% would punish an agent for a desktop
 *     application not being installed, which is the exact failure mode the
 *     brief forbids.
 *
 *   - **No worked days** (the agent was never on the clock in this window).
 *     There is nothing to measure output against, so there is no score at all —
 *     `null`, rendered as an em dash with "not on the clock" beside it, never
 *     0%. An agent who did no work on a day they *were* on the clock scores 0 on
 *     that metric, which is a real zero and is reported as one.
 *
 * ===========================================================================
 * Which configuration a report uses
 * ===========================================================================
 * **Always the current one**, including for a report about last month. The
 * configuration is a single row that is edited in place (see
 * `ProductivitySettings` in the schema), so re-running a report after a weight
 * change gives a different number — which is the honest behaviour for "how would
 * last month look under the targets we hold today", and is the simple,
 * predictable option the brief asks for. Every screen that shows a score says
 * which configuration produced it.
 */

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

export const METRIC_KEYS = ["calls", "leads", "meetings", "activity", "followUps"] as const;

export type MetricKey = (typeof METRIC_KEYS)[number];

export const METRIC_LABELS: Record<MetricKey, string> = {
  calls: "Calls",
  leads: "Leads processed",
  meetings: "Meetings booked",
  activity: "Activity",
  followUps: "Follow-ups",
};

/** One-line definitions, shown on the screens so the number explains itself. */
export const METRIC_DEFINITIONS: Record<MetricKey, string> = {
  calls: "Call outcomes saved against a lead.",
  leads: "Distinct leads a call outcome was saved against.",
  meetings: "Diary dates booked with a time on them.",
  activity:
    "Keyboard and mouse activity observed by the desktop Monitor. One component of five, and the smallest.",
  followUps:
    "Follow-ups completed: repeat calls on a lead already called, plus meetings marked done.",
};

/** The five targets. Counts are per agent per worked day; activity is a percentage. */
export interface ProductivityTargets {
  callsTarget: number;
  leadsTarget: number;
  meetingsTarget: number;
  followUpsTarget: number;
  activityTarget: number;
}

/** The five weights, in percentage points. They total exactly 100. */
export interface ProductivityWeights {
  callsWeight: number;
  leadsWeight: number;
  meetingsWeight: number;
  activityWeight: number;
  followUpsWeight: number;
}

export interface ProductivityConfigInput extends ProductivityTargets, ProductivityWeights {}

/** The configuration as it travels to a screen: the numbers, plus its provenance. */
export interface ProductivityConfig extends ProductivityConfigInput {
  /** ISO instant of the last change, or null while the defaults are in force. */
  updatedAt: string | null;
  /** The administrator who last changed it, or null. A label, never a permission. */
  updatedByName: string | null;
  /** True while no row has been written and the values below are the defaults. */
  isDefault: boolean;
}

/**
 * The defaults, which are the brief's and are the values a fresh database has.
 *
 * They are here once and read from here everywhere — the Prisma column defaults
 * mirror them so a row created by a raw `INSERT` agrees, and nothing else in the
 * application carries a copy.
 */
export const DEFAULT_PRODUCTIVITY_CONFIG: ProductivityConfigInput = {
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

/** Which target and which weight belong to each metric. One place, so a screen cannot pair them wrongly. */
export const METRIC_FIELDS: Record<
  MetricKey,
  { target: keyof ProductivityTargets; weight: keyof ProductivityWeights }
> = {
  calls: { target: "callsTarget", weight: "callsWeight" },
  leads: { target: "leadsTarget", weight: "leadsWeight" },
  meetings: { target: "meetingsTarget", weight: "meetingsWeight" },
  activity: { target: "activityTarget", weight: "activityWeight" },
  followUps: { target: "followUpsTarget", weight: "followUpsWeight" },
};

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

/** An expected refusal from the configuration endpoint, carrying its status. */
export class ProductivityConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    /** Which field the administrator needs to fix, when it is one field. */
    readonly field?: string,
  ) {
    super(message);
  }
}

/** A target above this is a typo, not a decision. */
const MAX_COUNT_TARGET = 10_000;

function wholeNumber(raw: unknown): number | null {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return null;
  return value;
}

/**
 * Turn an untrusted body into a configuration, or refuse it.
 *
 * Refuses rather than clamps — the opposite of `resolveRange`, and for the
 * reason `validateActivitySubmission` gives: a filter that is clamped costs a
 * confusing screen, whereas a silently corrected *target* is a number nobody
 * chose being used to appraise people. The administrator is told exactly which
 * field is wrong and nothing is written.
 */
export function validateProductivityConfig(body: unknown): ProductivityConfigInput {
  if (typeof body !== "object" || body === null) {
    throw new ProductivityConfigError("invalid_body", "Request body must be a JSON object.", 400);
  }

  const payload = body as Record<string, unknown>;

  const readTarget = (field: keyof ProductivityTargets, label: string, max: number): number => {
    const value = wholeNumber(payload[field]);
    if (value === null || value < 1 || value > max) {
      throw new ProductivityConfigError(
        "invalid_target",
        `${label} must be a whole number between 1 and ${max}.`,
        422,
        field,
      );
    }
    return value;
  };

  const targets: ProductivityTargets = {
    callsTarget: readTarget("callsTarget", "The calls target", MAX_COUNT_TARGET),
    leadsTarget: readTarget("leadsTarget", "The leads processed target", MAX_COUNT_TARGET),
    meetingsTarget: readTarget("meetingsTarget", "The meetings target", MAX_COUNT_TARGET),
    followUpsTarget: readTarget("followUpsTarget", "The follow-ups target", MAX_COUNT_TARGET),
    // A percentage, so its ceiling is 100 and not the count ceiling above.
    activityTarget: readTarget("activityTarget", "The activity target", 100),
  };

  const readWeight = (field: keyof ProductivityWeights, label: string): number => {
    const value = wholeNumber(payload[field]);
    if (value === null || value < 0 || value > 100) {
      throw new ProductivityConfigError(
        "invalid_weight",
        `${label} must be a whole number of percentage points between 0 and 100.`,
        422,
        field,
      );
    }
    return value;
  };

  const weights: ProductivityWeights = {
    callsWeight: readWeight("callsWeight", "The calls weight"),
    leadsWeight: readWeight("leadsWeight", "The leads weight"),
    meetingsWeight: readWeight("meetingsWeight", "The meetings weight"),
    activityWeight: readWeight("activityWeight", "The activity weight"),
    followUpsWeight: readWeight("followUpsWeight", "The follow-ups weight"),
  };

  const total = totalWeight(weights);
  if (total !== 100) {
    throw new ProductivityConfigError(
      "weights_must_total_100",
      `The five weights must total 100% (they total ${total}%).`,
      422,
    );
  }

  return { ...targets, ...weights };
}

export function totalWeight(weights: ProductivityWeights): number {
  return (
    weights.callsWeight +
    weights.leadsWeight +
    weights.meetingsWeight +
    weights.activityWeight +
    weights.followUpsWeight
  );
}

/* -------------------------------------------------------------------------- */
/* The score                                                                  */
/* -------------------------------------------------------------------------- */

/** The counted figures one score is calculated from. Every one is a real count. */
export interface ProductivityInput {
  calls: number;
  leadsProcessed: number;
  meetingsBooked: number;
  /** Repeat calls plus meetings completed — see the module note. */
  followUps: number;
  /** The existing activity figure, or null when nothing was observed. */
  activityPercentage: number | null;
  /** Local days in the window on which this agent had a work session. */
  workedDays: number;
}

/** One line of the breakdown an administrator reads to see where a score came from. */
export interface ScoreComponent {
  key: MetricKey;
  label: string;
  /** What the agent did. A count, or a percentage for activity. */
  actual: number | null;
  /** The configured target — per worked day for counts, absolute for activity. */
  target: number;
  /** `target × workedDays` for counts; the target itself for activity. Null when unavailable. */
  expected: number | null;
  /** 0–100, capped. Null when this metric could not be scored at all. */
  score: number | null;
  /** The configured weight, in percentage points. */
  weight: number;
  /** The weight actually applied after redistribution. Equals `weight` when nothing is missing. */
  appliedWeight: number;
  /** False when there is no honest way to score this metric — never scored as 0. */
  available: boolean;
  /** Why it could not be scored, for the screen to say so in words. */
  unavailableReason: string | null;
}

export interface ProductivityScore {
  /** 0–100 to one decimal, or null when nothing could be scored. */
  score: number | null;
  /** The same weighted score over the four output metrics only, excluding activity. */
  outputScore: number | null;
  /** The activity component's own score, or null. Reported beside the two above, never merged into them. */
  activityScore: number | null;
  components: ScoreComponent[];
  /** Days the expectations were scaled by. Zero means there is no score. */
  workedDays: number;
}

/**
 * One metric as a percentage of what was expected of it, capped at 100.
 *
 * The cap is the brief's, and it is what stops one runaway figure from carrying
 * a score: a hundred calls against a target of fifty is 100%, not 200%, so an
 * agent cannot dial their way past a month with no meetings in it. Exceeding a
 * target is still visible — the raw count is in the column beside the score —
 * it just does not buy credit against the other four metrics.
 *
 * Rounded to a whole number here rather than at the end, deliberately: the
 * breakdown on the agent detail screen shows these five figures and the overall
 * beneath them, and the reader must be able to check the arithmetic. Weighting
 * unrounded values would produce an overall that does not follow from the
 * numbers on screen, which is the opposite of the transparency this is for.
 */
export function metricScore(actual: number, expected: number): number | null {
  if (!Number.isFinite(expected) || expected <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((actual / expected) * 100)));
}

/**
 * The whole calculation, in one pure function.
 *
 * The weighted sum is over the components that could be scored, divided by the
 * weight those components carry between them — so a missing activity figure
 * redistributes its 10 points across the other four rather than scoring zero.
 * With everything present the divisor is 100 and this is the plain weighted
 * average the brief describes.
 */
export function scoreProductivity(
  input: ProductivityInput,
  config: ProductivityConfigInput,
): ProductivityScore {
  const workedDays = Math.max(0, Math.round(input.workedDays));

  // The output metrics all share one expectation scale, and it is zero when the
  // agent was never on the clock. Nothing is scored against zero.
  const noClock = workedDays === 0;
  const clockReason = "Not on the clock in this period.";

  const output: Array<{ key: MetricKey; actual: number; target: number }> = [
    { key: "calls", actual: input.calls, target: config.callsTarget },
    { key: "leads", actual: input.leadsProcessed, target: config.leadsTarget },
    { key: "meetings", actual: input.meetingsBooked, target: config.meetingsTarget },
    { key: "followUps", actual: input.followUps, target: config.followUpsTarget },
  ];

  const components: ScoreComponent[] = output.map(({ key, actual, target }) => {
    const expected = noClock ? null : target * workedDays;
    return {
      key,
      label: METRIC_LABELS[key],
      actual,
      target,
      expected,
      score: expected === null ? null : metricScore(actual, expected),
      weight: config[METRIC_FIELDS[key].weight],
      appliedWeight: 0,
      available: expected !== null,
      unavailableReason: expected === null ? clockReason : null,
    };
  });

  const activityAvailable = input.activityPercentage !== null;
  components.push({
    key: "activity",
    label: METRIC_LABELS.activity,
    actual: input.activityPercentage,
    target: config.activityTarget,
    expected: activityAvailable ? config.activityTarget : null,
    score: activityAvailable ? metricScore(input.activityPercentage!, config.activityTarget) : null,
    weight: config.activityWeight,
    appliedWeight: 0,
    available: activityAvailable,
    unavailableReason: activityAvailable
      ? null
      : "No activity was observed — the desktop Monitor reported nothing in this period.",
  });

  // Order the breakdown the way the brief writes it, so the screen and the
  // specification read the same way down the page.
  components.sort((a, b) => METRIC_KEYS.indexOf(a.key) - METRIC_KEYS.indexOf(b.key));

  const scored = components.filter((component) => component.score !== null);
  const availableWeight = scored.reduce((sum, component) => sum + component.weight, 0);

  for (const component of components) {
    component.appliedWeight =
      component.score === null || availableWeight === 0
        ? 0
        : round1((component.weight / availableWeight) * 100);
  }

  return {
    score: weighted(scored),
    outputScore: weighted(scored.filter((component) => component.key !== "activity")),
    activityScore: components.find((component) => component.key === "activity")?.score ?? null,
    components,
    workedDays,
  };
}

/**
 * The weighted mean of a set of scored components, renormalised over the weight
 * they actually carry. Null for an empty set — never 0.
 */
function weighted(components: readonly ScoreComponent[]): number | null {
  let total = 0;
  let weight = 0;

  for (const component of components) {
    if (component.score === null) continue;
    total += component.score * component.weight;
    weight += component.weight;
  }

  return weight === 0 ? null : round1(total / weight);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/* -------------------------------------------------------------------------- */
/* What crosses to the browser                                                */
/* -------------------------------------------------------------------------- */

/**
 * One agent's row on the dashboard.
 *
 * Activity and productivity are two fields and stay two fields all the way to
 * the screen. `activityPercentage` is the existing Monitor figure verbatim;
 * `productivity.score` is the weighted output score that has it as one small
 * component. Neither is ever written into the other.
 */
export interface AgentProductivityRow {
  userId: string;
  name: string;
  username: string;
  isActive: boolean;
  /** A shift is open right now. A fact about this instant, not about the window. */
  online: boolean;

  /** Seconds in a work session inside the window — the portal's own clock. */
  trackedSeconds: number;
  /** Of those, the seconds covered by intervals with input in them. */
  activeSeconds: number;
  /** Tracked minus active, including any time the Monitor was not running. */
  idleSeconds: number;
  /** The existing duration-weighted activity figure, or null. */
  activityPercentage: number | null;

  calls: number;
  leadsProcessed: number;
  meetingsBooked: number;
  meetingsCompleted: number;
  /** Diary dates set with no time on them. Reported, never scored — see the module note. */
  callbacksScheduled: number;
  /** Repeat calls on a lead already called. The first half of FOLLOW-UPS. */
  followUpCalls: number;
  /** `followUpCalls + meetingsCompleted`, which is what the score uses. */
  followUps: number;

  productivity: ProductivityScore;
  /** Position among agents with a score, best first. Null when unscored. */
  rank: number | null;
}

export const PRODUCTIVITY_SORT_KEYS = [
  "productivity",
  "activity",
  "calls",
  "leads",
  "meetings",
  "tracked",
  "name",
] as const;

export type ProductivitySortKey = (typeof PRODUCTIVITY_SORT_KEYS)[number];

export const PRODUCTIVITY_SORT_LABELS: Record<ProductivitySortKey, string> = {
  productivity: "Productivity",
  activity: "Activity",
  calls: "Calls",
  leads: "Leads processed",
  meetings: "Meetings",
  tracked: "Tracked time",
  name: "Name",
};

export interface ProductivityFilters {
  /** One agent, or everybody. A filter, never a permission. */
  userId: string | null;
  /** Keep agents at or above this activity percentage. Excludes the unobserved. */
  minActivity: number | null;
  minProductivity: number | null;
  maxProductivity: number | null;
  sort: ProductivitySortKey;
  direction: "asc" | "desc";
}

export const DEFAULT_PRODUCTIVITY_FILTERS: ProductivityFilters = {
  userId: null,
  minActivity: null,
  minProductivity: null,
  maxProductivity: null,
  sort: "productivity",
  direction: "desc",
};

/**
 * The dashboard's filters, from a query string.
 *
 * Clamped and defaulted rather than rejected, the same way `resolveRange` treats
 * a malformed date: none of these decides whether the caller may see anything —
 * `apiAdmin()` did that before the query string was read — so an unrecognised
 * value is a stale bookmark, not an attack, and a report should not 400 an
 * administrator over one. The id is checked against a cuid shape only because a
 * value that cannot be an id can go straight to null and save a query; it is a
 * filter either way, and an id that names an administrator or nobody simply
 * returns no rows.
 */
export function resolveProductivityFilters(params: URLSearchParams): ProductivityFilters {
  const percentage = (raw: string | null): number | null => {
    if (raw === null || raw.trim() === "") return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 100) return null;
    return Math.round(value);
  };

  const agent = params.get("agent");
  const sort = params.get("sort");
  const direction = params.get("direction");

  return {
    userId: !agent || agent === "all" || !/^[a-z0-9]{1,64}$/i.test(agent) ? null : agent,
    minActivity: percentage(params.get("minActivity")),
    minProductivity: percentage(params.get("minProductivity")),
    maxProductivity: percentage(params.get("maxProductivity")),
    sort: (PRODUCTIVITY_SORT_KEYS as readonly string[]).includes(sort ?? "")
      ? (sort as ProductivitySortKey)
      : DEFAULT_PRODUCTIVITY_FILTERS.sort,
    direction: direction === "asc" ? "asc" : "desc",
  };
}

/** The team figures above the table. Sums of real counts; the two percentages are means. */
export interface ProductivityTotals {
  agents: number;
  trackedSeconds: number;
  calls: number;
  leadsProcessed: number;
  meetingsBooked: number;
  followUps: number;
  /** Tracked-time-weighted mean activity over the listed agents, or null. */
  activityPercentage: number | null;
  /** Plain mean productivity over the listed agents that have a score, or null. */
  productivity: number | null;
  /** How many of the listed agents could not be scored, and are excluded above. */
  unscored: number;
}

export interface ProductivityReport {
  range: { key: string; from: string; to: string; label: string };
  config: ProductivityConfig;
  agents: AgentProductivityRow[];
  totals: ProductivityTotals;
  /** Best first, across every agent in the window before filtering. Admin-only, like everything here. */
  ranking: Array<{ userId: string; name: string; score: number }>;
  asOf: string;
}

/** One agent's detail screen: the row above, with the working shown. */
export interface AgentProductivityDetail {
  agent: { id: string; name: string; username: string; isActive: boolean };
  range: { key: string; from: string; to: string; label: string };
  config: ProductivityConfig;
  row: AgentProductivityRow;
  asOf: string;
}

/** `87.4` -> `87%`, `null` -> `—`. The one place productivity rounding is decided. */
export function formatScore(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`;
}

/**
 * The band a productivity score falls in, for colouring a cell.
 *
 * Deliberately the same three-plus-none shape as `activityBand`, and
 * deliberately *not* the same thresholds: this figure is measured against
 * targets an administrator set, so the bands are "met it", "close" and "well
 * short", which is a judgement the configuration has already licensed. The
 * activity bands stay descriptive because that figure licenses no judgement.
 */
export type ProductivityBand = "none" | "low" | "moderate" | "high";

export function productivityBand(value: number | null): ProductivityBand {
  if (value === null) return "none";
  if (value < 50) return "low";
  if (value < 80) return "moderate";
  return "high";
}
