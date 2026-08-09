import type { LeadStats } from "@/lib/leadUtils";

/**
 * The three numbers that decide what an agent does next. Everything else lives
 * behind the Breakdown panel and the Reports view.
 *
 * These were three numerals separated by hairlines — honest, and completely
 * flat. They are now three cards, which is a different claim: a card says "this
 * is a thing you can look at on its own", and at the top of a workspace that is
 * exactly right. What has *not* changed is the weight given to them. The cards
 * are 1fr each and short; the numeral is still the element and the card is only
 * what holds it apart from its neighbours. A dashboard where the metric strip
 * is taller than four rows of the table it introduces has its priorities
 * backwards.
 *
 * Colour is contextual and earned. `Total leads` is never anything but neutral
 * — it is a fact about the workspace, not a call to action. The two callback
 * counts turn accent *only when they are non-zero*, because a permanently red
 * number is a number people stop seeing.
 */
export default function HeadlineStrip({ stats }: { stats: LeadStats }) {
  const overdue = stats.callbackOverdue;
  const dueToday = stats.callbackDueToday;

  return (
    <div className="grid grid-cols-1 gap-3 py-4 sm:grid-cols-3">
      <Metric
        value={stats.total}
        label="Total leads"
        hint="in this workspace"
        icon={<ListIcon />}
      />
      <Metric
        value={dueToday}
        label="Callback today"
        hint={dueToday > 0 ? "waiting on a call" : "nothing owed today"}
        live={dueToday > 0}
        icon={<ClockIcon />}
      />
      <Metric
        value={overdue}
        label="Overdue"
        hint={overdue > 0 ? "past their date" : "nothing running late"}
        live={overdue > 0}
        icon={<AlertIcon />}
      />
    </div>
  );
}

function Metric({
  value,
  label,
  hint,
  live,
  icon,
}: {
  value: number;
  label: string;
  hint: string;
  /** Non-zero and time-critical: warms the border and lights the corner. */
  live?: boolean;
  icon: React.ReactNode;
}) {
  return (
    <div className="metric px-4 py-3.5" data-tone={live ? "live" : "calm"}>
      {/* `relative` lifts the content over the corner wash `.metric[data-tone]`
          paints behind it. */}
      <div className="relative flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          {/* The label stays an eyebrow — quiet, wide-tracked, clearly
              subordinate. The numeral is the element; this only names it. */}
          <span className="eyebrow flex items-center gap-1.5 whitespace-nowrap">
            {live && (
              <span
                aria-hidden="true"
                className="h-1 w-1 rounded-full bg-accent shadow-[0_0_6px_0_var(--c-accent)]"
              />
            )}
            {label}
          </span>
          <span
            className={`display-num text-[32px] leading-none ${
              live ? "text-accent" : "text-fg"
            }`}
          >
            {value.toLocaleString()}
          </span>
          {/* The one line of prose in the card. It is what turns "3" into
              "3 leads past their date", and it costs 14px of height. */}
          <span className="text-meta text-fg-3">{hint}</span>
        </div>

        {/* Iconography sits at fg-4 — the step reserved for marks rather than
            text, where 3:1 is the bar and 4.5:1 is not required. It labels the
            card at a glance and is never the thing being read. */}
        <span
          aria-hidden="true"
          className={live ? "text-accent/70" : "text-fg-4"}
        >
          {icon}
        </span>
      </div>
    </div>
  );
}

function ListIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4">
      <path
        d="M5.5 4h8M5.5 8h8M5.5 12h8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="2.6" cy="4" r="1" fill="currentColor" />
      <circle cx="2.6" cy="8" r="1" fill="currentColor" />
      <circle cx="2.6" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 4.6V8l2.4 1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4">
      <path
        d="M8 2.2 14.6 13.4H1.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8 6.6v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="11.3" r="0.7" fill="currentColor" />
    </svg>
  );
}
