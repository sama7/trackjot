import { RecordingOrigin } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Delete an account: the data, and then the identity it signs in with.
 *
 * ## Why the identity has to go too
 *
 * Deleting only the local row did not end anything. The Clerk session was still
 * valid, so the very next request resolved the same sign-in subject, found no
 * user, and — because users are created lazily on first sight — created a
 * fresh, empty account under it. You pressed "Delete my account" and were back
 * inside TrackJot one redirect later, with a new user id and nothing in it,
 * which looks exactly like a deletion that did not happen.
 *
 * So the sign-in identity is deleted as well. That revokes every session it
 * has, on every device, and a later sign-in — with Google or by email — starts
 * a genuinely new account instead of silently reviving this one.
 *
 * ## Order, and what happens if the second half fails
 *
 * The data goes first, in one transaction. It is the part that matters for
 * privacy, and it is the part we can guarantee. The identity is deleted after;
 * if the identity provider refuses, the data is still gone and the caller is
 * told, so the page can say so honestly rather than claim a clean exit.
 */
export async function deleteAccount(
  user: { id: string; authSubject: string },
  deleteIdentity: (authSubject: string) => Promise<void>,
): Promise<{ identityDeleted: boolean }> {
  /**
   * Their own typed-in entries go too. `recordings.created_by` is SET NULL, so a
   * manually entered recording would otherwise outlive its author as an orphan.
   * These are creator-scoped by policy, so no one else's note can point at one.
   * Provider catalog rows are kept: they are the shared catalog, not this
   * person's data.
   */
  const authored = await prisma.recording.findMany({
    where: { origin: RecordingOrigin.user, createdById: user.id },
    select: { id: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.user.delete({ where: { id: user.id } });
    /**
     * Refuse to re-create this identity while a token issued before now could
     * still be presented (see `isDeletedIdentity`). A day is far longer than
     * any such token lives; older tombstones are pruned here so the table only
     * ever holds the last day's deletions.
     */
    await tx.identityTombstone.upsert({
      where: { authSubject: user.authSubject },
      create: { authSubject: user.authSubject },
      update: { deletedAt: new Date() },
    });
    await tx.identityTombstone.deleteMany({
      where: { deletedAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
    });
    if (authored.length > 0) {
      /**
       * Only the ones nothing else still points at. Policy keeps a typed-in
       * entry out of everyone else's reach, but the note and item foreign keys
       * are RESTRICT — so if that policy were ever breached, deleting the row
       * outright would abort this whole transaction and leave the account
       * undeletable. An orphan left behind is the lesser failure.
       */
      await tx.recording.deleteMany({
        where: {
          id: { in: authored.map((r) => r.id) },
          notes: { none: {} },
          collectionItems: { none: {} },
        },
      });
    }
  });

  try {
    await deleteIdentity(user.authSubject);
    return { identityDeleted: true };
  } catch (error) {
    // Already gone counts as done: a retry, or a race with another device.
    if (isNotFound(error)) return { identityDeleted: true };
    console.error("deleteAccount: identity deletion failed", error instanceof Error ? error.name : "unknown");
    return { identityDeleted: false };
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: number }).status === 404
  );
}
