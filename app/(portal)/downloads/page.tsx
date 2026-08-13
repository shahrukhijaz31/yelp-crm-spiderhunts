import type { Metadata } from "next";
import { connection } from "next/server";

import MonitorDownloadPanel from "@/components/MonitorDownloadPanel";
import { requireUser } from "@/lib/authz";
import { installerStatus, monitorRelease } from "@/lib/monitorRelease";

export const metadata: Metadata = {
  title: "Downloads — SpiderHunts Leads Portal",
};

/**
 * Downloads. Every role, and one thing to download.
 *
 * `requireUser` and no role check, for the same reason `/account/password` has
 * none: the Monitor is what an agent is required to run, so the page exists for
 * them first. Administrators reach it too — they install the same build. That
 * is why `/downloads` is deliberately not an admin prefix in `lib/access.ts`.
 *
 * The figures are read here, on the server, and passed down as props: the panel
 * is a client component and must never be able to see a filesystem path, so the
 * only things that cross are a name, a platform, a version, a filename, a size
 * and a boolean. The `stat` behind `installerStatus` is why `connection()` is
 * called first — this page describes a file on disk that changes between
 * deployments, so it must be rendered per request rather than baked at build
 * time, when the installer is not there at all.
 */
export default async function DownloadsPage() {
  await connection();
  await requireUser("/downloads");

  const release = monitorRelease();
  const { sizeBytes } = await installerStatus();

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <MonitorDownloadPanel
        info={{ ...release, available: sizeBytes !== null, sizeBytes }}
      />
    </main>
  );
}
