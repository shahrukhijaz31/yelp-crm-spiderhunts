import PageLoading from "@/components/PageLoading";

/**
 * The one screen that still reads the whole table by design — it writes every
 * matching row to a file — so it is also the one most likely to be waited on.
 */
export default function LoadingExport() {
  return <PageLoading label="Gathering leads to export" />;
}
