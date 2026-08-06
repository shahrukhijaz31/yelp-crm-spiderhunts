/**
 * Placeholder. Settings has a nav slot because the next build phase needs
 * somewhere to put the API key and the upload endpoint configuration — see the
 * stub at `app/api/leads/upload/route.ts`.
 */
export default function SettingsPage() {
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
    <main className="mx-auto w-full max-w-[1760px] flex-1 px-7 py-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        <header>
          <h1 className="display-num text-[26px] leading-none text-fg">Settings</h1>
          <p className="mt-2.5 text-[13px] leading-relaxed text-fg-3">
            Nothing to configure yet — the portal runs on in-memory data. This
            is where the backend configuration lands next.
          </p>
        </header>

        <ul className="flex flex-col gap-px overflow-hidden rounded-xl border border-line bg-line">
          {PLANNED.map((item) => (
            <li key={item.title} className="bg-surface px-5 py-4">
              <div className="flex items-center gap-2.5">
                <h2 className="text-[13.5px] font-medium text-fg">{item.title}</h2>
                <span className="rounded border border-line-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-4">
                  Planned
                </span>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-4">
                {item.body}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
