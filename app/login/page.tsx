import type { Metadata } from "next";
import { redirect } from "next/navigation";

import LoginForm from "@/components/LoginForm";
import { safeCallbackUrl } from "@/lib/access";
import { getSessionUser } from "@/lib/session";

export const metadata: Metadata = {
  title: "Sign in — SpiderHunts Leads Portal",
  description: "Sign in to the SpiderHunts Leads Portal",
};

/**
 * The sign-in route, and the only page outside the authenticated group.
 *
 * Two jobs beyond rendering the form:
 *
 *   Already signed in? Go to the workspace. The proxy makes the same redirect
 *   on the cheap signal (a cookie exists); this one asks the database whether
 *   that cookie is a live session, which is the answer that counts.
 *
 *   Sanitise `?callbackUrl=`. It arrives from the address bar, so it is
 *   attacker-controlled by definition. `safeCallbackUrl` reduces it to an
 *   internal path or throws it away, and the same function runs again on the
 *   API side — the value is never trusted at either end.
 */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const user = await getSessionUser();
  const { callbackUrl } = await searchParams;

  const destination = safeCallbackUrl(
    typeof callbackUrl === "string" ? callbackUrl : null,
  );

  if (user) redirect(destination);

  return <LoginForm callbackUrl={destination} />;
}
