import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import type { User } from "@prisma/client";

/**
 * Resolving the acting user.
 *
 * Two invariants from AGENTS.md §9, both load-bearing:
 *
 *   1. The acting identity comes ONLY from the verified server session. No
 *      route, Server Action, import, or legacy mapping may accept a
 *      TrackJot user ID from client input. This is the defect that made
 *      v1's note endpoints world-writable.
 *   2. Concurrent first requests for one verified subject must create exactly
 *      ONE local row.
 *
 * On (2): Prisma's `upsert` is find-then-create and races — two simultaneous
 * first requests can both miss and both insert, and one gets a unique
 * violation. `INSERT … ON CONFLICT` pushes the race into PostgreSQL, where the
 * unique index on auth_subject settles it atomically.
 *
 * Clerk webhooks are deliberately not used. The row is created lazily here on
 * first authenticated request, which removes an endpoint, a signature check,
 * and an idempotency problem from the sprint.
 */

/** The verified Clerk subject, or null when signed out. */
export async function currentAuthSubject(): Promise<string | null> {
  const { userId } = await auth();
  return userId ?? null;
}

/**
 * Resolve the local user for a verified subject, creating it on first sight.
 *
 * Fast path is a plain SELECT — the insert only runs the first time a given
 * subject is seen, so steady-state traffic performs no writes here.
 */
export async function resolveLocalUser(authSubject: string): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { authSubject } });
  if (existing) return existing;

  // Only on the create path, so an ordinary request pays nothing for it.
  if (await isDeletedIdentity(authSubject)) throw new DeletedIdentityError();

  // DO UPDATE rather than DO NOTHING: on conflict, DO NOTHING returns no rows
  // and would need a second round trip. Touching updated_at makes RETURNING
  // fire on both the insert and the conflict path.
  const rows = await prisma.$queryRaw<User[]>`
    INSERT INTO users (id, auth_subject, created_at, updated_at)
    VALUES (gen_random_uuid(), ${authSubject}, now(), now())
    ON CONFLICT (auth_subject)
      DO UPDATE SET updated_at = users.updated_at
    RETURNING
      id,
      auth_subject   AS "authSubject",
      username,
      display_name   AS "displayName",
      avatar_url     AS "avatarUrl",
      created_at     AS "createdAt",
      updated_at     AS "updatedAt"
  `;

  const user = rows.at(0);
  if (!user) {
    // Unreachable: ON CONFLICT DO UPDATE always returns a row.
    throw new Error("Failed to resolve local user.");
  }
  return user;
}

/**
 * The acting user for a request that requires authentication.
 *
 * Throws when signed out. Route handlers translate that into a non-disclosing
 * response — never one that reveals whether a resource exists.
 */
export async function requireUser(): Promise<User> {
  const authSubject = await currentAuthSubject();
  if (!authSubject) throw new UnauthenticatedError();
  try {
    return await resolveLocalUser(authSubject);
  } catch (error) {
    // A token that outlived its account: treat the visitor as signed out and
    // say why, rather than handing them a fresh, empty account.
    if (error instanceof DeletedIdentityError) redirect("/?account=deleted");
    throw error;
  }
}

/**
 * The acting user, for a page — and only once they have chosen a username.
 *
 * TrackJot is meant to be social, and a handle is what a share is attributed
 * to and what following will address. It was optional, set later on the
 * account page if at all, which left accounts nobody could be pointed at. So
 * every signed-in page goes through this, and an account without a username is
 * sent to choose one first, with `returnTo` carried so they land where they
 * were going.
 *
 * Enforced here, on the server, rather than by the sign-up form: a step the
 * client can skip is not a requirement. Accounts that existed before this rule
 * meet the same step on their next visit.
 *
 * Pages only. A Server Action must not redirect mid-mutation, so actions keep
 * `requireUser`; the pages that host them cannot be reached without a handle.
 */
export async function requireOnboardedUser(returnTo: string): Promise<User> {
  const user = await requireUser();
  if (!user.username) redirect(`/welcome?next=${encodeURIComponent(safeReturnPath(returnTo))}`);
  return user;
}

/**
 * Only same-site paths are followed after onboarding. `//evil.example` and
 * `https://…` are both "URLs starting with a slash or a scheme" that a naive
 * check would happily redirect to — an open redirect on the sign-up path.
 */
export function safeReturnPath(path: string | null | undefined): string {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    return "/notes";
  }
  return path;
}

/** The acting user, or null when signed out. For pages that render both ways. */
export async function optionalUser(): Promise<User | null> {
  const authSubject = await currentAuthSubject();
  if (!authSubject) return null;
  try {
    return await resolveLocalUser(authSubject);
  } catch (error) {
    if (error instanceof DeletedIdentityError) return null;
    throw error;
  }
}

/**
 * Was this sign-in subject's account deleted moments ago?
 *
 * Deleting the Clerk user revokes its sessions, but a session token already in
 * a browser stays valid until it expires — about a minute — and users are
 * created lazily on first sight. Without this, any request in that window
 * re-created an empty account under the deleted identity. See
 * `lib/users/delete-account.ts`.
 */
export async function isDeletedIdentity(authSubject: string): Promise<boolean> {
  const row = await prisma.identityTombstone.findUnique({
    where: { authSubject },
    select: { authSubject: true },
  });
  return row !== null;
}

export class DeletedIdentityError extends Error {
  constructor() {
    super("That account was deleted.");
    this.name = "DeletedIdentityError";
  }
}

export class UnauthenticatedError extends Error {
  constructor() {
    super("Not authenticated.");
    this.name = "UnauthenticatedError";
  }
}
