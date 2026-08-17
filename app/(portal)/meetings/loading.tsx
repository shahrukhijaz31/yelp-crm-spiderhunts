import PageLoading from "@/components/PageLoading";

/** The agenda is read from Postgres on every visit — say so while it is. */
export default function LoadingMeetings() {
  return <PageLoading label="Loading meetings" />;
}
