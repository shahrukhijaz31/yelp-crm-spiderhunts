"use client";

import { AlertTriangle, PhoneCall, Users2 } from "lucide-react";

import CountUp from "./CountUp";
import { useSpotlight } from "./useSpotlight";
import type { LeadStats } from "@/lib/leadUtils";

/**
 * The three numbers that decide what an agent does next.
 *
 * **One object, three segments** — not three cards. Three separately-bordered
 * cards is the default dashboard shape, and it makes three related figures
 * look like three unrelated widgets that happen to be adjacent. Divided by
 * hairlines inside a single panel, they read as what they are: one summary of
 * one list, split three ways.
 *
 * Each segment has a *semantic personality*, and it is carried by where the
 * light in it comes from rather than by how much colour is in it:
 *
 *   Total leads      neutral. A fact about the workspace, never coloured.
 *   Callback today   warm. An amber corner wash when there is work owed.
 *   Overdue          danger. An accent wash, an accent numeral, and an accent
 *                    hairline along its top edge — the only gradient border in
 *                    the strip, and only when the count is non-zero.
 *
 * The tone is *earned*, never permanent: at zero, all three are identical
 * neutral segments. A dashboard where "Overdue" is red whether or not anything
 * is overdue has taught its users to ignore red.
 *
 * Nothing here is invented. Three counts in, three counts out — no trends, no
 * percentages, no deltas.
 */
export default function HeadlineStrip({ stats }: { stats: LeadStats }) {
  const dueToday = stats.callbackDueToday;
  const overdue = stats.callbackOverdue;

  return (
    <div className="panel grid grid-cols-1 gap-px overflow-hidden bg-line sm:grid-cols-3">
      {[
        {
          value: stats.total,
          label: "Total leads",
          hint: "in this workspace",
          icon: Users2,
          tone: "neutral" as const,
          live: false,
        },
        {
          value: dueToday,
          label: "Callback today",
          hint: dueToday > 0 ? "waiting on a call" : "nothing owed today",
          icon: PhoneCall,
          tone: "warm" as const,
          live: dueToday > 0,
        },
        {
          value: overdue,
          label: "Overdue",
          hint: overdue > 0 ? "past their date" : "nothing running late",
          icon: AlertTriangle,
          tone: "danger" as const,
          live: overdue > 0,
        },
      ].map((metric, index) => (
        // A short stagger on first paint only — the strip assembles left to
        // right, then never moves again. In CSS rather than in Framer: a
        // `motion.div` with an `initial` would server-render these three
        // segments at `opacity: 0`, so the first thing an agent sees on the
        // worklist would depend on JavaScript having arrived. `.rise-in` runs
        // without it and stops under `prefers-reduced-motion`.
        <div
          key={metric.label}
          className="rise-in"
          style={
            { "--delay": `${index * 60}ms`, "--rise": "6px" } as React.CSSProperties
          }
        >
          <Metric {...metric} />
        </div>
      ))}
    </div>
  );
}

/**
 * Where each segment's light comes from, and what colour it is.
 *
 * The wash reads `--c-wash-*`, not `--c-warning` / `--c-accent`. Those two are
 * *text* colours, and on the light theme they are deliberately dark — #7d5106
 * for warning — so painting a gradient with one produced a muddy beige rather
 * than a warm glow. The wash tokens are the bright end of each hue in both
 * themes, at whatever alpha that theme needs. See `globals.css`.
 */
const TONES = {
  neutral: { wash: "", numeral: "text-fg", icon: "text-fg-4", dot: "" },
  warm: {
    wash: "before:bg-[radial-gradient(15rem_10rem_at_100%_0%,var(--c-wash-warning),transparent_72%)]",
    numeral: "text-warning",
    icon: "text-warning",
    dot: "bg-warning",
  },
  danger: {
    wash: "before:bg-[radial-gradient(15rem_10rem_at_100%_0%,var(--c-wash-accent),transparent_72%)]",
    numeral: "text-accent",
    icon: "text-accent",
    dot: "bg-accent",
  },
} as const;

function Metric({
  value,
  label,
  hint,
  live,
  tone,
  icon: Icon,
}: {
  value: number;
  label: string;
  hint: string;
  live: boolean;
  tone: keyof typeof TONES;
  icon: React.ElementType;
}) {
  const spotlight = useSpotlight<HTMLDivElement>();
  const style = TONES[live ? tone : "neutral"];

  return (
    <div
      {...spotlight}
      // `spotlight` gives it cursor-tracking light; `edge-accent` draws the
      // fading accent hairline along the top, and only the live danger segment
      // gets it — it is the strip's one gradient border, so it has to mean
      // something.
      className={`spotlight group relative isolate h-full bg-surface px-4 py-3.5 transition-colors duration-200 ${
        live && tone === "danger" ? "edge-accent" : ""
      }`}
    >
      {/* The tone wash, on its own layer beneath the content. A pseudo-element
          rather than a background on the segment itself, so it can sit under
          the spotlight without the two gradients having to be composed into
          one declaration. */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 -z-10 before:absolute before:inset-0 ${style.wash}`}
      />

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-caption font-medium text-fg-3">
            {label}
            {live && (
              <span
                aria-hidden="true"
                className={`h-1.5 w-1.5 rounded-full ${style.dot}`}
              />
            )}
          </p>
          <p
            className={`display-num mt-1.5 text-[28px] leading-none transition-colors duration-300 ${style.numeral}`}
          >
            <CountUp value={value} />
          </p>
          {/* The one line of prose. It is what turns "3" into "3 leads past
              their date", and it costs 16px of height. */}
          <p className="mt-1.5 truncate text-meta text-fg-3">{hint}</p>
        </div>

        {/* Iconography sits at fg-4 — the step reserved for marks rather than
            text, where 3:1 is the bar. It nudges up a pixel on hover, which is
            the smallest possible acknowledgement that the card is a thing. */}
        <Icon
          className={`h-4 w-4 shrink-0 transition-all duration-300 group-hover:-translate-y-0.5 ${style.icon}`}
          strokeWidth={1.75}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}
