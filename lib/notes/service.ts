import { randomBytes } from "node:crypto";
import { trackUrl } from "@/lib/music/provider-url";
import { DatePrecision, PlacePrecision, Visibility, type Note } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { providerLabel } from "@/lib/notes/list";

/**
 * Note operations.
 *
 * Every function here takes `ownerId` as its FIRST argument, and that value
 * comes only from `requireUser()` — never from a request body, a query string,
 * or a form field. This is the exact defect that made v1's endpoints
 * world-writable: `routes/note.js` read `user` from the query string.
 *
 * The second rule: **owner-scoped queries, not fetch-then-check.** Reading a
 * row and then comparing its owner leaves a window and invites a missing
 * branch. Instead the owner is part of the `where` clause, so a mismatched
 * request finds nothing — and "not found" is also the right thing to tell a
 * stranger, since confirming a note exists is itself a disclosure.
 */

export const noteBodySchema = z
  .string()
  .trim()
  .min(1, "A note needs something in it.")
  .max(10_000, "Notes are limited to 10,000 characters.");

export const createNoteSchema = z.object({
  recordingId: z.string().uuid(),
  body: noteBodySchema,
  collectionItemId: z.string().uuid().nullish(),
  displayTitle: z.string().trim().max(500).nullish(),
  displayArtist: z.string().trim().max(500).nullish(),
  experiencedAt: z.coerce.date().nullish(),
  experiencedPrecision: z.nativeEnum(DatePrecision).nullish(),
  placeLabel: z.string().trim().max(200).nullish(),
  placePrecision: z.nativeEnum(PlacePrecision).nullish(),
  /** Opaque, client-supplied, per-submission. See the column's comment. */
  idempotencyKey: z.string().trim().min(8).max(100).nullish(),
});

/**
 * When the listening happened, at the precision the writer actually claimed.
 *
 * The stored timestamp is the FIRST instant of the stated range — a year is
 * January 1st, a month is the 1st — so the precision has to travel with it or
 * rendering invents a day nobody said. Both are stored or neither is; a database
 * CHECK enforces that pairing.
 */
export const experiencedSchema = z
  .object({
    experiencedAt: z.coerce.date().nullish(),
    experiencedPrecision: z.nativeEnum(DatePrecision).nullish(),
  })
  .refine(
    (v) => Boolean(v.experiencedAt) === Boolean(v.experiencedPrecision),
    "A date needs a precision, and a precision needs a date.",
  );

/**
 * Where it happened.
 *
 * Coordinates are accepted ONLY alongside `exact`, which a person has to opt
 * into. A journal that quietly accumulates precise coordinates is a liability
 * the writer never asked for, so the default path stores a label and nothing
 * more — "The Horseshoe, Toronto" locates a memory without locating a person.
 */
export const placeSchema = z
  .object({
    placeLabel: z.string().trim().max(200).nullish(),
    placePrecision: z.nativeEnum(PlacePrecision).nullish(),
    placeLat: z.coerce.number().min(-90).max(90).nullish(),
    placeLon: z.coerce.number().min(-180).max(180).nullish(),
  })
  .refine(
    (v) =>
      (v.placeLat == null && v.placeLon == null) ||
      (v.placePrecision === PlacePrecision.exact && v.placeLat != null && v.placeLon != null),
    "Coordinates are only stored for a place you marked exact.",
  );

export const updateNoteSchema = z.object({
  body: noteBodySchema.optional(),
  displayTitle: z.string().trim().max(500).nullish(),
  displayArtist: z.string().trim().max(500).nullish(),
  experiencedAt: z.coerce.date().nullish(),
  experiencedPrecision: z.nativeEnum(DatePrecision).nullish(),
  placeLabel: z.string().trim().max(200).nullish(),
  placePrecision: z.nativeEnum(PlacePrecision).nullish(),
  placeLat: z.coerce.number().min(-90).max(90).nullish(),
  placeLon: z.coerce.number().min(-180).max(180).nullish(),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;

/** Raised when a resource is absent *or* belongs to someone else. Callers must
 *  not distinguish the two: the difference is exactly what an attacker wants. */
export class NoteNotFoundError extends Error {
  constructor() {
    super("Note not found.");
    this.name = "NoteNotFoundError";
  }
}

export class InvalidCollectionContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCollectionContextError";
  }
}

/** 24 bytes of base64url — unguessable, and rotatable without touching the note. */
function newShareToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Validate optional playlist context.
 *
 * A note may point at a collection item to preserve "this track, in this
 * playlist". Two things must hold, and both are checked here rather than
 * trusted: the item must belong to the note's owner, and it must point at the
 * same recording. Otherwise a user could attach their note to a stranger's
 * collection, or to a different song entirely.
 */
async function assertCollectionContext(
  ownerId: string,
  collectionItemId: string,
  recordingId: string,
): Promise<void> {
  const item = await prisma.collectionItem.findFirst({
    where: { id: collectionItemId, collection: { ownerId } },
    select: { recordingId: true },
  });

  if (!item) {
    throw new InvalidCollectionContextError("That collection item is not available.");
  }
  if (item.recordingId !== recordingId) {
    throw new InvalidCollectionContextError(
      "That collection item refers to a different recording.",
    );
  }
}

export async function createNote(
  ownerId: string,
  input: CreateNoteInput,
  /** Runs inside a caller's transaction when one is supplied. */
  tx: Pick<typeof prisma, "note"> = prisma,
): Promise<Note> {
  const data = createNoteSchema.parse(input);

  if (data.collectionItemId) {
    await assertCollectionContext(ownerId, data.collectionItemId, data.recordingId);
  }

  /**
   * A retry of the same submission returns the note the first attempt wrote.
   *
   * Checked before inserting for the ordinary case, and caught below for the
   * race where two retries arrive together — the unique index is what actually
   * guarantees this, the lookup only avoids a pointless failed insert.
   */
  if (data.idempotencyKey) {
    const existing = await tx.note.findFirst({
      where: { ownerId, idempotencyKey: data.idempotencyKey },
    });
    if (existing) return existing;
  }

  return tx.note.create({
    data: {
      ownerId,
      recordingId: data.recordingId,
      body: data.body,
      collectionItemId: data.collectionItemId ?? null,
      displayTitle: data.displayTitle ?? null,
      displayArtist: data.displayArtist ?? null,
      experiencedAt: data.experiencedAt ?? null,
      experiencedPrecision: data.experiencedPrecision ?? null,
      placeLabel: data.placeLabel ?? null,
      placePrecision: data.placePrecision ?? null,
      idempotencyKey: data.idempotencyKey ?? null,
      visibility: Visibility.private,
    },
  });
}

export const createCollectionNoteSchema = z.object({
  collectionId: z.string().uuid(),
  body: noteBodySchema,
});

/**
 * A note about a collection as a whole.
 *
 * §3a called this the honest form of collection-level journaling and deferred
 * it: a note about "this playlist" is a real thought, and the alternative —
 * a bookmark with no tracks — was not. The database enforces that a note is
 * about exactly one of a recording or a collection (`notes_exactly_one_subject`),
 * so the two paths cannot be confused after the fact.
 *
 * Ownership of the collection is checked here rather than trusted, for the same
 * reason `assertCollectionContext` exists: a valid UUID belonging to someone
 * else must not become a place to attach writing.
 */
export async function createCollectionNote(
  ownerId: string,
  input: z.infer<typeof createCollectionNoteSchema>,
): Promise<Note> {
  const data = createCollectionNoteSchema.parse(input);

  const collection = await prisma.collection.findFirst({
    where: { id: data.collectionId, ownerId },
    select: { id: true },
  });
  if (!collection) throw new NoteNotFoundError();

  return prisma.note.create({
    data: {
      ownerId,
      collectionId: collection.id,
      body: data.body,
      visibility: Visibility.private,
    },
  });
}

export async function listNotes(ownerId: string, limit = 50): Promise<Note[]> {
  return prisma.note.findMany({
    where: { ownerId },
    orderBy: { updatedAt: "desc" },
    take: Math.min(limit, 200),
  });
}

/** Owner-scoped read. A valid id belonging to someone else returns null. */
export async function getNote(ownerId: string, noteId: string): Promise<Note | null> {
  return prisma.note.findFirst({ where: { id: noteId, ownerId } });
}

export async function updateNote(
  ownerId: string,
  noteId: string,
  input: UpdateNoteInput,
): Promise<Note> {
  const data = updateNoteSchema.parse(input);

  // updateMany scopes by owner in the WHERE clause, so a mismatch updates zero
  // rows rather than throwing something that could be mistaken for success.
  const result = await prisma.note.updateMany({
    where: { id: noteId, ownerId },
    data: {
      ...(data.body !== undefined ? { body: data.body } : {}),
      ...(data.displayTitle !== undefined ? { displayTitle: data.displayTitle } : {}),
      ...(data.displayArtist !== undefined ? { displayArtist: data.displayArtist } : {}),
      ...(data.experiencedAt !== undefined ? { experiencedAt: data.experiencedAt } : {}),
      ...(data.experiencedPrecision !== undefined
        ? { experiencedPrecision: data.experiencedPrecision }
        : {}),
      ...(data.placeLabel !== undefined ? { placeLabel: data.placeLabel } : {}),
      ...(data.placePrecision !== undefined ? { placePrecision: data.placePrecision } : {}),
      ...(data.placeLat !== undefined ? { placeLat: data.placeLat } : {}),
      ...(data.placeLon !== undefined ? { placeLon: data.placeLon } : {}),
    },
  });

  if (result.count === 0) throw new NoteNotFoundError();
  return prisma.note.findFirstOrThrow({ where: { id: noteId, ownerId } });
}

export async function deleteNote(ownerId: string, noteId: string): Promise<void> {
  const result = await prisma.note.deleteMany({ where: { id: noteId, ownerId } });
  if (result.count === 0) throw new NoteNotFoundError();
}

/**
 * Set a note's visibility — the single entry point for who can read it.
 *
 * There were three functions here (publish, unpublish, rotate) and a UI that
 * offered "Rotate link" as a peer of "Make private". That asked the user to
 * reason about token lifecycles to answer a question they actually hold in
 * terms of audience: nobody, anyone I send this to, or everybody. So the shape
 * is now one setting with three values, and the token is an implementation
 * detail that follows from it.
 *
 * Rotation is gone as a separate control because it was never a distinct
 * intent. Its real use — "this link got out, kill it" — is *making the note
 * private*, which clears the token; sharing again mints a fresh one. Same
 * outcome, one concept instead of two.
 *
 * `publishedAt` is set on first publication and kept afterwards, so it records
 * when the note was first shared rather than when it was last touched.
 */
export async function setNoteVisibility(
  ownerId: string,
  noteId: string,
  visibility: Visibility,
): Promise<Note> {
  const existing = await getNote(ownerId, noteId);
  if (!existing) throw new NoteNotFoundError();

  /**
   * `updatedAt` is carried forward explicitly, which overrides Prisma's
   * `@updatedAt`. **Changing who can read a note is not editing it.** The card
   * says "edited <date>", and letting a visibility change move that date makes
   * the timestamp claim something false about the writing — which is the one
   * thing a journal's dates cannot afford.
   */
  const keepEditedAt = { updatedAt: existing.updatedAt };

  if (visibility === Visibility.private) {
    return prisma.note.update({
      where: { id: existing.id },
      // Clearing the token matters: going private must revoke the old link,
      // not merely stop advertising it. Un-sharing also withdraws the note from
      // any collection it was travelling with.
      data: {
        ...keepEditedAt,
        visibility,
        shareToken: null,
        publishedAt: null,
        sharedInCollection: false,
      },
    });
  }

  return prisma.note.update({
    where: { id: existing.id },
    data: {
      ...keepEditedAt,
      visibility,
      shareToken: existing.shareToken ?? newShareToken(),
      publishedAt: existing.publishedAt ?? new Date(),
    },
  });
}

/** Convenience wrappers. The three-value setter above is the real interface. */
export function publishNoteUnlisted(ownerId: string, noteId: string): Promise<Note> {
  return setNoteVisibility(ownerId, noteId, Visibility.unlisted);
}

export function unpublishNote(ownerId: string, noteId: string): Promise<Note> {
  return setNoteVisibility(ownerId, noteId, Visibility.private);
}

/**
 * Fetch a note by share token, for anonymous viewers.
 *
 * Requires the visibility to still permit it — un-publishing must actually
 * revoke access, not merely hide the link.
 */
export async function getSharedNote(shareToken: string): Promise<Note | null> {
  return prisma.note.findFirst({
    where: {
      shareToken,
      visibility: { in: [Visibility.unlisted, Visibility.public] },
    },
  });
}

/** Exactly the fields an anonymous reader of a shared note may see. */
export interface SharedNote {
  body: string;
  title: string;
  artist: string | null;
  albumTitle: string | null;
  artworkUrl: string | null;
  artworkThumbUrl: string | null;
  providerUrl: string | null;
  providerName: string | null;
  tags: string[];
  /** How to credit the writer, or null when they have not chosen a name. */
  author: string | null;
  /** The collection this note is about, by name only. */
  aboutCollection: string | null;
}

/**
 * Read a shared note for an anonymous viewer.
 *
 * **The select list is the security boundary.** It is explicit and narrow by
 * intent: whatever is not named here cannot leak, however this page is edited
 * later. That is why this exists rather than the page reaching for the `Note`
 * row and picking fields off it — a row carries `owner_id`, the internal UUID,
 * the share token, and now a place and coordinates, and a page that holds all
 * of that is one careless line away from rendering it.
 *
 * Three deliberate omissions:
 *
 *   - **The place and the "heard on" date.** A shared note is a quotation, not
 *     a check-in; location in particular is the one field where an accidental
 *     disclosure is not recoverable. Adding either is a small change, and it
 *     should be a decision rather than a side effect of enriching a card.
 *   - **Anything identifying beyond a chosen name.** No email, no auth subject,
 *     no user id — the author is a display name the person picked, or nothing.
 *   - **Visibility and token.** A viewer has no use for them and a prober does.
 */
export async function getSharedNoteView(shareToken: string): Promise<SharedNote | null> {
  const note = await prisma.note.findFirst({
    where: {
      shareToken,
      visibility: { in: [Visibility.unlisted, Visibility.public] },
    },
    select: {
      body: true,
      displayTitle: true,
      displayArtist: true,
      owner: { select: { username: true, displayName: true } },
      tags: { select: { tag: { select: { name: true } } } },
      collection: { select: { name: true } },
      recording: {
        select: {
          title: true,
          artistDisplay: true,
          releaseTitle: true,
          artworkUrl: true,
          artworkThumbUrl: true,
          album: { select: { title: true, artworkUrl: true, artworkThumbUrl: true } },
          externalIds: {
            select: { provider: true, providerId: true, providerUrl: true },
            take: 1,
          },
        },
      },
    },
  });

  if (!note) return null;

  const recording = note.recording;
  const external = recording?.externalIds[0];

  return {
    body: note.body,
    title: note.displayTitle ?? recording?.title ?? note.collection?.name ?? "A note",
    artist: note.displayArtist ?? recording?.artistDisplay ?? null,
    albumTitle: recording?.album?.title ?? recording?.releaseTitle ?? null,
    artworkUrl: recording?.artworkUrl ?? recording?.album?.artworkUrl ?? null,
    artworkThumbUrl:
      recording?.artworkThumbUrl ??
      recording?.album?.artworkThumbUrl ??
      recording?.artworkUrl ??
      recording?.album?.artworkUrl ??
      null,
    providerUrl: trackUrl(external),
    providerName: providerLabel(external?.provider ?? null),
    tags: note.tags.map((t) => t.tag.name),
    // A username the person chose, their display name, or nothing at all.
    // "Shared by null" is better than inventing an identity for someone who
    // has not picked one.
    author: note.owner.username ?? note.owner.displayName ?? null,
    aboutCollection: note.collection?.name ?? null,
  };
}
