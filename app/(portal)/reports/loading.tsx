import PageLoading from "@/components/PageLoading";

/**
 * Covers `/reports` and everything beneath it — the team, time, timesheet,
 * productivity and app-usage screens all aggregate across large tables, and
 * the nearest ancestor `loading.tsx` is the one a nested route inherits.
 */
export default function LoadingReport() {
  return <PageLoading label="Building the report" />;
}
