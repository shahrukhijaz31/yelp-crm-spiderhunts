import PageLoading from "@/components/PageLoading";

/**
 * The portal's default wait, inherited by every screen in the group that does
 * not name its own.
 *
 * It sits inside the shell, so the sidebar, the top bar and the work clock
 * stay put and only the content area is replaced — a navigation looks like a
 * panel filling in rather than the application reloading.
 *
 * A route with something better to say adds its own `loading.tsx` beside its
 * page (the nearest one wins); `/leads/[id]` draws a skeleton instead, because
 * there the shape of what is arriving is known.
 */
export default function LoadingPortalPage() {
  return <PageLoading />;
}
