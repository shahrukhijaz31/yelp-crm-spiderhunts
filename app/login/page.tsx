import type { Metadata } from "next";

import LoginForm from "@/components/LoginForm";

export const metadata: Metadata = {
  title: "Sign in — SpiderHunts Leads Portal",
  description: "Sign in to the SpiderHunts Leads Portal",
};

/**
 * The sign-in route. The form is a client component because everything on this
 * screen is interaction — validation, the reveal toggle, the submit state — so
 * the page itself is just the mount point.
 */
export default function LoginPage() {
  return <LoginForm />;
}
