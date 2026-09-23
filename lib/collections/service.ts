import { randomBytes } from "node:crypto";
import { trackUrl } from "@/lib/music/provider-url";
import { Visibility, type Collection } from "@prisma/client";
import { prisma } from "@/lib/db";
import { providerLabel } from "@/lib/notes/list";

/**
 * Publishing a collection — and the invariant that makes it safe.
 *
 * **Publishing a collection never publishes the notes inside it.** It publishes
 * the notes you ticked, and the default for every note is unticked.
 *
 * That distinction is now load-bearing, because sharing selected notes is a
 * feature people want and the previous version simply refused it. The original
 * comment here said that if per-note publication were ever wanted it should be
 * "an explicit second query for notes whose own visibility permits it, added
 * deliberately, with its own tests, not by relaxing this one" — and that is
 * exactly what `sharedNotesFor` below is. The shape of the safety changed, not
 * the amount:
 *
 *   - `getSharedCollection` still never touches the `notes` relation, so the
 *     tracklist query cannot leak a note by accident.
 *   - Notes travel only via a separate query gated on an explicit per-note
 *     boolean that only `setSharedNotes` writes.
 *   - Turning a note private clears that boolean (see `setNoteVisibility`), so
 *     "make this private" is never partially honoured.
 */

export class CollectionNotFoundError extends Error {
  constructor() {
    super("Collection not found");
    this.name = "CollectionNotFoundError";
  }
}

/** 32 bytes of entropy, url-safe. The URL exposes this, never the UUID. */
function newShareToken(): string {
  return randomBytes(24).toString("base64url");
}

export async function getCollection(
  ownerId: string,
  collectionId: string,
): Promise<Collection | null> {
  return prisma.collection.findFirst({ where: { id: collectionId, ownerId } });
}

/**
 * Set a collection's visibility. See the note on `setNoteVisibility` for why
 * this is one three-valued setting rather than publish/unpublish/rotate.
 */
export async function setCollectionVisibility(
  ownerId: string,
  collectionId: string,
  visibility: Visibility,
): Promise<Collection> {
  const existing = await getCollection(ownerId, collectionId);
  if (!existing) throw new CollectionNotFoundError();

  if (visibility === Visibility.private) {
    return prisma.$transaction(async (tx) => {
      // Notes stop travelling with a collection that is no longer shared. They
      // keep their own visibility — un-sharing the container must not silently
      // un-share a note the owner published on its own.
      await tx.note.updateMany({
        where: {
          ownerId,
          OR: [{ collectionId }, { collectionItem: { collectionId } }],
        },
        data: { sharedInCollection: false },
      });
      return tx.collection.update({
        where: { id: existing.id },
        // Clearing the token matters: going private must revoke the old link,
        // not merely stop advertising it.
        data: { visibility, shareToken: null },
      });
    });
  }

  return prisma.collection.update({
    where: { id: existing.id },
    data: { visibility, shareToken: existing.shareToken ?? newShareToken() },
  });
}

export function publishCollectionUnlisted(
  ownerId: string,
  collectionId: string,
): Promise<Collection> {
  return setCollectionVisibility(ownerId, collectionId, Visibility.unlisted);
}

export function unpublishCollection(
  ownerId: string,
  collectionId: string,
): Promise<Collection> {
  return setCollectionVisibility(ownerId, collectionId, Visibility.private);
}

/**
 * Rename a collection, or change its description.
 *
 * Owner-scoped through `updateMany`'s WHERE clause rather than a read-then-check,
 * for the same reason every other mutation here is: a mismatched owner updates
 * zero rows instead of relying on a branch someone could forget.
 *
 * This edits the collection's *label*, never its contents. Items belong to an
 * immutable snapshot; re-importing is what changes them.
 */
export async function updateCollection(
  ownerId: string,
  collectionId: string,
  input: { name?: string; description?: string | null },
): Promise<void> {
  const name = input.name?.trim();
  if (name !== undefined && name.length === 0) {
    throw new CollectionNotFoundError();
  }

  const result = await prisma.collection.updateMany({
    where: { id: collectionId, ownerId },
    data: {
      ...(name !== undefined ? { name: name.slice(0, 300) } : {}),
      ...(input.description !== undefined
        ? { description: input.description?.trim().slice(0, 2000) || null }
        : {}),
    },
  });

  if (result.count === 0) throw new CollectionNotFoundError();
}

/**
 * Delete a collection.
 *
 * Its items go with it, and `notes.collection_item_id` is `ON DELETE SET NULL`,
 * so notes written in playlist context survive as plain notes about the track.
 * Losing the collection must never lose the writing — that ordering is the
 * whole reason the FK is nullable.
 *
 * Collection-level notes have no track to fall back to, so they are removed
 * with the collection they describe; the confirmation says so.
 */
export async function deleteCollection(ownerId: string, collectionId: string): Promise<void> {
  const result = await prisma.collection.deleteMany({ where: { id: collectionId, ownerId } });
  if (result.count === 0) throw new CollectionNotFoundError();
}

/** Exactly the fields an anonymous viewer is allowed to see. */
export interface SharedCollection {
  name: string;
  description: string | null;
  sourceUrl: string | null;
  /** Which service the source link points at. The URL already says so; naming
   *  it just spares the reader from having to read a URL to find out. */
  sourceName: string | null;
  snapshotAt: Date | null;
  tracks: Array<{
    position: number;
    title: string;
    artistDisplay: string;
    providerUrl: string | null;
    /** Only notes the owner explicitly ticked for this collection. */
    notes: string[];
  }>;
  /** A ticked note about the collection as a whole, if there is one. */
  about: string | null;
}

/**
 * The notes the owner chose to send along with a shared collection.
 *
 * A separate query from the tracklist, deliberately: the tracklist query must
 * stay incapable of returning a note, so that a future change to it cannot leak
 * one. This one asks for notes and nothing else, and every condition in its
 * WHERE clause has to hold — the collection is this one, the note is ticked,
 * and the note is not itself private.
 */
async function sharedNotesFor(
  collectionId: string,
): Promise<{ byItemId: Map<string, string[]>; about: string | null }> {
  const notes = await prisma.note.findMany({
    where: {
      sharedInCollection: true,
      visibility: { in: [Visibility.unlisted, Visibility.public] },
      OR: [{ collectionId }, { collectionItem: { collectionId } }],
    },
    select: { body: true, collectionId: true, collectionItemId: true },
    orderBy: { createdAt: "asc" },
  });

  const byItemId = new Map<string, string[]>();
  let about: string | null = null;

  for (const note of notes) {
    if (note.collectionItemId) {
      const existing = byItemId.get(note.collectionItemId) ?? [];
      existing.push(note.body);
      byItemId.set(note.collectionItemId, existing);
    } else if (note.collectionId === collectionId) {
      about ??= note.body;
    }
  }

  return { byItemId, about };
}

/**
 * Choose which of a collection's notes travel with it when it is shared.
 *
 * Owner-scoped at both ends: the collection must be theirs, and only notes they
 * wrote inside it are touched. Ticking a note also publishes it — a note that
 * appears on a public page but is marked private in the owner's list would be a
 * lie in one place or the other.
 */
export async function setSharedNotes(
  ownerId: string,
  collectionId: string,
  noteIds: string[],
): Promise<void> {
  const collection = await getCollection(ownerId, collectionId);
  if (!collection) throw new CollectionNotFoundError();

  const scope = {
    ownerId,
    OR: [{ collectionId }, { collectionItem: { collectionId } }],
  };

  const wanted = await prisma.note.findMany({
    where: { ...scope, id: { in: noteIds } },
    select: { id: true, shareToken: true },
  });
  const wantedIds = wanted.map((n) => n.id);

  await prisma.$transaction(async (tx) => {
    /**
     * Untick everything else first, so a note removed from the selection stops
     * travelling even though the request only lists what should stay.
     *
     * The `notIn` clause is omitted when nothing is selected rather than given a
     * placeholder id — the column is a uuid, and an empty-string sentinel is
     * rejected by the driver before it reaches SQL. "Untick all of them" is a
     * where clause with no id condition at all.
     */
    await tx.note.updateMany({
      where: wantedIds.length > 0 ? { ...scope, id: { notIn: wantedIds } } : scope,
      data: { sharedInCollection: false },
    });

    for (const note of wanted) {
      await tx.note.update({
        where: { id: note.id },
        data: {
          sharedInCollection: true,
          visibility: Visibility.unlisted,
          shareToken: note.shareToken ?? newShareToken(),
          publishedAt: new Date(),
        },
      });
    }
  });
}

/**
 * Read a collection by share token, for anonymous viewers.
 *
 * The select list is explicit and narrow by intent. `notes` is absent, so no
 * private note can be reached through this path; owner ids, internal UUIDs,
 * import records and provider metadata are absent for the same reason —
 * whatever is not selected cannot leak.
 */
export async function getSharedCollection(shareToken: string): Promise<SharedCollection | null> {
  const collection = await prisma.collection.findFirst({
    where: {
      shareToken,
      visibility: { in: [Visibility.unlisted, Visibility.public] },
    },
    select: {
      id: true,
      name: true,
      description: true,
      sourceUrl: true,
      sourceProvider: true,
      sourceSnapshotAt: true,
      items: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          position: true,
          recording: {
            select: {
              title: true,
              artistDisplay: true,
              artists: {
                orderBy: { position: "asc" },
                select: { artist: { select: { name: true } } },
              },
              externalIds: { select: { provider: true, providerId: true, providerUrl: true }, take: 1 },
            },
          },
        },
      },
    },
  });

  if (!collection) return null;

  const shared = await sharedNotesFor(collection.id);

  return {
    name: collection.name,
    description: collection.description,
    sourceUrl: collection.sourceUrl,
    sourceName: providerLabel(collection.sourceProvider),
    snapshotAt: collection.sourceSnapshotAt,
    about: shared.about,
    tracks: collection.items.map((item) => ({
      position: item.position,
      title: item.recording.title,
      artistDisplay:
        item.recording.artists.length > 0
          ? item.recording.artists.map((ra) => ra.artist.name).join(", ")
          : item.recording.artistDisplay,
      providerUrl: trackUrl(item.recording.externalIds[0]),
      notes: shared.byItemId.get(item.id) ?? [],
    })),
  };
}
