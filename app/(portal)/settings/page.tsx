import AccessDenied from "@/components/AccessDenied";
import { requireRole } from "@/lib/authz";

/**
 * Settings — ADMIN only. Still a placeholder for the configuration that lands
 * next, but it is the page that will hold the API key and the data-source
 * switch, so it is administrator territory from the start rather than being
 * opened up and locked down later.
 */
export default async function SettingsPage() {
  const { allowed } = await requireRole("ADMIN", "/settings");
  if (!allowed) return <AccessDenied />;

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
            Nothing to configure yet — the portal runs on in-memory data. This
            is where the backend configuration lands next.
          </p>
        </header>

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
