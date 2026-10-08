"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Laptop, Loader2, ShieldCheck } from "lucide-react";

import type { PairingRequestInfo } from "@/lib/monitorPairingRules";
import { approveWorkstation, denyWorkstation } from "@/lib/workstationsClient";

/**
 * "Connect DESKTOP-7F3K?" — the screen the Monitor sends an agent to.
 *
 * One decision, two buttons, and as little else as possible. Everything on it
 * is there to answer one question: *is this the computer in front of me?* The
 * machine's own name for itself, when it asked, and a countdown so a request
 * that has gone stale says so rather than failing on the click.
 *
 * There is no code to type — see `lib/monitorPairing.ts` for what stands in
 * for one. What this screen owes in return is a sentence making clear that
 * approving is not a formality, and a Deny that needs nothing but a click:
 * somebody who did not start this request is exactly the person who can prove
 * nothing about the workstation, and Deny has to work for them.
 *
 * Layout follows Change password and Downloads: a title, an intro that says
 * what the screen does, and one `panel` holding the work.
 */
export default function ApproveWorkstationPanel({
  request,
}: {
  request: PairingRequestInfo | null;
}) {
  const router = useRouter();

  const [working, setWorking] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<"approved" | "denied" | null>(null);
  const [expired, setExpired] = useState(false);

  // The countdown. A request lives five minutes, and a page left open past
  // that should say so rather than offering a button that is going to fail.
  const expiresAt = request ? new Date(request.expiresAt).getTime() : 0;
  const [secondsLeft, setSecondsLeft] = useState(() =>
    request ? Math.max(0, Math.round((expiresAt - Date.now()) / 1000)) : 0,
  );

  useEffect(() => {
    if (!request || done) return;

    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) setExpired(true);
    };

    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [request, expiresAt, done]);

  async function approve() {
    if (!request || working) return;
    setWorking("approve");
    setError(null);

    const result = await approveWorkstation(request.requestId);

    if (!result.ok) {
      setError(result.message);
      setWorking(null);
      return;
    }

    setDone("approved");
    setWorking(null);
    // Land them where they can immediately undo it, which is the right
    // destination for anything that grants access.
    router.refresh();
  }

  async function deny() {
    if (!request || working) return;
    setWorking("deny");
    setError(null);

    await denyWorkstation(request.requestId);

    // Deliberately not branching on the result: denying is idempotent and the
    // endpoint answers the same way whatever the request turns out to be, so
    // there is nothing here for the screen to report.
    setDone("denied");
    setWorking(null);
  }

  if (!request) {
    return (
      <Shell>
        <section className="panel flex flex-col gap-4 px-6 py-6">
          <Message
            tone="quiet"
            icon={<AlertCircle className="mt-px h-4 w-4 shrink-0" strokeWidth={1.75} />}
          >
            There is nothing waiting to be connected. A request lasts five
            minutes — press <strong className="font-medium">Connect</strong> in
            SpiderHunts Monitor again and this page will open fresh.
          </Message>
        </section>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <section className="panel flex flex-col gap-4 px-6 py-6">
          {done === "approved" ? (
            <>
              <Message
                tone="good"
                icon={<CheckCircle2 className="mt-px h-4 w-4 shrink-0" strokeWidth={1.75} />}
              >
                <strong className="font-medium">{name(request)}</strong> is
                connected. The Monitor on that computer will pick this up within
                a few seconds — you can close this page.
              </Message>
              <a href="/account/workstations" className="ui-btn ui-btn-ghost self-start">
                See your workstations
              </a>
            </>
          ) : (
            <Message
              tone="quiet"
              icon={<ShieldCheck className="mt-px h-4 w-4 shrink-0" strokeWidth={1.75} />}
            >
              Nothing was connected. If you did not start this yourself and it
              keeps happening, tell an administrator.
            </Message>
          )}
        </section>
      </Shell>
    );
  }

  return (
    <Shell>
      <section className="panel flex flex-col gap-5 px-6 py-6">
        <div className="flex items-start gap-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line-2 bg-surface text-fg-2">
            <Laptop className="h-5 w-5" strokeWidth={1.75} aria-hidden="true" />
          </span>

          <div className="min-w-0 flex-1">
            <h2 className="text-cell font-semibold text-fg">{name(request)}</h2>
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {request.platform && (
                <span className="chip border border-line-2 text-fg-3">{request.platform}</span>
              )}
              {request.appVersion && (
                <span className="chip border border-line-2 font-mono text-fg-3">
                  Monitor {request.appVersion}
                </span>
              )}
              <span className="chip border border-line-2 text-fg-3">
                {expired ? "Expired" : `Expires in ${formatCountdown(secondsLeft)}`}
              </span>
            </div>
          </div>
        </div>

        <p className="text-ui leading-relaxed text-fg-3">
          Only connect this if you have just pressed{" "}
          <strong className="font-medium text-fg-2">Connect</strong> in
          SpiderHunts Monitor on this computer. Connecting lets that machine
          report your activity, screenshots and application usage while you are
          on the clock.
        </p>

        {error && (
          <p
            role="alert"
            className="flex items-start gap-2.5 rounded-md border border-danger-line bg-danger-bg px-3 py-2.5 text-caption leading-relaxed text-danger"
          >
            <AlertCircle className="mt-px h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <span>{error}</span>
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <button
            type="button"
            onClick={() => void approve()}
            disabled={expired || working !== null}
            aria-busy={working === "approve"}
            className="ui-btn ui-btn-primary"
          >
            {working === "approve" ? (
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} aria-hidden="true" />
            ) : (
              <CheckCircle2 className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
            )}
            {working === "approve" ? "Connecting…" : "Connect"}
          </button>

          <button
            type="button"
            onClick={() => void deny()}
            disabled={working !== null}
            aria-busy={working === "deny"}
            className="ui-btn ui-btn-ghost"
          >
            Not me
          </button>

          {expired && (
            <p role="status" className="text-caption leading-relaxed text-fg-3">
              This request has expired. Press Connect in the Monitor again.
            </p>
          )}
        </div>
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <header>
        <h1 className="page-title">Connect a workstation</h1>
        <p className="mt-3 page-intro">
          A computer running SpiderHunts Monitor is asking to report under your
          account.
        </p>
      </header>
      {children}
    </div>
  );
}

function Message({
  tone,
  icon,
  children,
}: {
  tone: "good" | "quiet";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const colours =
    tone === "good"
      ? "border-success-line bg-success-bg text-success"
      : "border-line-2 bg-surface text-fg-3";

  return (
    <p
      role="status"
      className={`flex items-start gap-2.5 rounded-md border px-3 py-2.5 text-caption leading-relaxed ${colours}`}
    >
      {icon}
      <span>{children}</span>
    </p>
  );
}

/** A workstation that never said what it was called still has to be referred to. */
function name(request: PairingRequestInfo): string {
  return request.deviceName ?? "An unnamed computer";
}

function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest}s`;
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}
