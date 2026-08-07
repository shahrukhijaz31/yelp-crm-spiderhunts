import AccessDenied from "@/components/AccessDenied";
import UsersPanel from "@/components/UsersPanel";
import { requireRole } from "@/lib/authz";
import { listUsers } from "@/lib/userDb";

/**
 * User management — ADMIN only.
 *
 * The list is read on the server, after the role check, so an agent who types
 * this URL receives the refusal screen and no user data at all — not even the
 * set of names, which is the part worth withholding.
 */
export default async function UsersPage() {
  const { user, allowed } = await requireRole("ADMIN", "/users");
  if (!allowed) return <AccessDenied />;

  const users = await listUsers();

  return (
    <main className="mx-auto w-full max-w-[1760px] flex-1 px-7 py-8">
      <UsersPanel
        currentUserId={user.id}
        // Dates are serialised for the client component: `PublicUser` carries
        // real Date objects on the server, and only the display form crosses.
        users={users.map((row) => ({
          ...row,
          lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        }))}
      />
    </main>
  );
}
