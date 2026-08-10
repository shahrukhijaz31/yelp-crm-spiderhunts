import type { Metadata } from "next";

import ChangePasswordPanel from "@/components/ChangePasswordPanel";
import { requireUser } from "@/lib/authz";

export const metadata: Metadata = {
  title: "Change password — SpiderHunts Leads Portal",
};

/**
 * Change your own password. Every role, and only ever your own account.
 *
 * There is no `[id]` here and no version of this route that takes one: the
 * account being changed is whoever the session resolves to, decided on the
 * server by `/api/account/password` from the same session. So this page needs
 * `requireUser` and no role check — an agent reaching it is not an
 * authorization problem, it is the intended user.
 *
 * `requireUser` is what the portal layout above already does, and repeating it
 * costs one memoised lookup (`getSessionUser` is `cache`d for the render).
 * Stating it here keeps the rule that every page guards itself, so nobody has
 * to read the layout to know who may open this.
 */
export default async function ChangePasswordPage() {
  await requireUser("/account/password");

  return (
    <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6">
      <ChangePasswordPanel />
    </main>
  );
}
