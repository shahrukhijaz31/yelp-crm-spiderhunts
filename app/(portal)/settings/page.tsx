import { connection } from "next/server";

import AccessDenied from "@/components/AccessDenied";
import ProductivitySettingsPanel from "@/components/ProductivitySettingsPanel";
import { requireRole } from "@/lib/authz";
import { readProductivityConfig } from "@/lib/productivity";

/**
 * Settings — ADMIN only, and now with something real on it.
 *
 * The productivity targets and weights live here rather than on a configuration
 * screen of their own, because this application already has the page for
 * administrator-owned configuration and the brief is explicit about not
 * inventing a second mechanism. They are the *only* settings that are stored in
 * the database: the activity cadence, the idle threshold and the screenshot
 * limits stay environment variables (`lib/activityPolicy.ts`,
 * `lib/screenshotPolicy.ts`) precisely because nobody — not even an
 * administrator — should be able to change how activity is measured from a
 * browser. Targets are a management decision; a calibration is not.
 *
 * The guard is the first statement, and `apiAdmin()` guards the endpoint behind
 * the form independently.
 */
export default async function SettingsPage() {
  const { allowed } = await requireRole("ADMIN", "/settings");
  if (!allowed) return <AccessDenied />;

  await connection();

  const productivityConfig = await readProductivityConfig();

  const PLANNED = [
    {
      title: "API key",
      body: "The key the scraper will send as x-api-key when POSTing a CSV to /api/leads/upload.",
    },
    {
      title: "Data source",
      body: "Switch between the bundled sample data and a live database once the backend lands.",
    },
    {
      title: "Callback defaults",
      body: "Default follow-up interval when an agent sets a callback without picking a date.",
    },
  ];

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header>
          <h1 className="page-title">Settings</h1>
          <p className="mt-3 page-intro">
            Administrator configuration. Agents cannot reach this page or the
            endpoints behind it.
          </p>
        </header>

        <ProductivitySettingsPanel initialConfig={productivityConfig} />

        <ul className="panel flex flex-col gap-px overflow-hidden bg-line">
          {PLANNED.map((item) => (
            <li key={item.title} className="bg-surface px-5 py-4">
              <div className="flex items-center gap-2.5">
                <h2 className="text-cell font-semibold text-fg">{item.title}</h2>
                <span className="rounded border border-line-2 px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wider text-fg-3">
                  Planned
                </span>
              </div>
              <p className="mt-2 text-ui leading-relaxed text-fg-3">
                {item.body}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
