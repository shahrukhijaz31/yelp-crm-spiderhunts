import type { Metadata } from "next";
import { redirect } from "next/navigation";

import LoginForm from "@/components/LoginForm";
import { safeCallbackUrl } from "@/lib/access";
import { describePendingChallenge } from "@/lib/loginOtp";
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
 *
 *   Resolve the pending OTP step, if there is one. Someone who refreshes the
 *   verification screen, or navigates back to `/login` mid-verification, gets
 *   the boxes again rather than an empty password form — because which step
 *   they are on is a fact about the server, read here from the pending cookie,
 *   and not React state that a reload throws away.
 *
 * Being on the second step is not being signed in, and this page is the proof:
 * the redirect above is driven by `getSessionUser`, which knows nothing about
 * `login_otps`. A pending challenge renders a form; only a session leaves.
 */
export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const user = await getSessionUser();
  const { callbackUrl } = await searchParams;

  const destination = safeCallbackUrl(
    typeof callbackUrl === "string" ? callbackUrl : null,
  );

  if (user) redirect(destination);

  // Never throws the page: a pending challenge that cannot be read is simply a
  // sign-in that starts from the password again.
  const pendingChallenge = await describePendingChallenge().catch(() => null);

  return <LoginForm callbackUrl={destination} pendingChallenge={pendingChallenge} />;
}
