import PageLoading from "@/components/PageLoading";

/** The first page is read from Postgres on every visit — say so while it is. */
export default function LoadingDemoWebsites() {
  return <PageLoading label="Loading demo websites" />;
}
