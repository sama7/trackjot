import { prisma } from "@/lib/db";
import { NoteNotFoundError, noteBodySchema, updateNoteSchema, type UpdateNoteInput } from "@/lib/notes/service";
import { applyNoteTags } from "@/lib/notes/tags";

/**
 * Save everything the note editor holds, or nothing.
 *
 * ## Why this exists
 *
 * The editor submitted twice: once to update the note, once to set its tags.
 * Two separate writes can half-succeed, and the form closed as soon as both
 * promises settled, so "saved" was shown whether or not either had landed. An
 * empty body was worse — the update action returned early without saving and
 * without saying so, and the editor closed as though it had worked.
 *
 * So validation runs first, in full, and the note and its tags are written in a
 * single transaction. Either the whole edit is stored or none of it is, and the
 * caller is told which.
 */
export class EmptyNoteError extends Error {
  constructor() {
    super("A note needs some words in it.");
    this.name = "EmptyNoteError";
  }
}

export async function saveNoteEdit(
  ownerId: string,
  noteId: string,
  input: UpdateNoteInput,
  tagNames: string[],
) {
  // Validate before any write, so a rejected edit touches nothing.
  const body = noteBodySchema.safeParse(input.body ?? "");
  if (!body.success) throw new EmptyNoteError();
  const data = updateNoteSchema.parse({ ...input, body: body.data });

  return prisma.$transaction(async (tx) => {
    // Owner scope is in the WHERE clause: someone else's valid note id updates
    // zero rows and is reported as missing, never as another person's success.
    const result = await tx.note.updateMany({
      where: { id: noteId, ownerId },
      data: {
        body: data.body,
        ...(data.experiencedAt !== undefined ? { experiencedAt: data.experiencedAt } : {}),
        ...(data.experiencedPrecision !== undefined
          ? { experiencedPrecision: data.experiencedPrecision }
          : {}),
        ...(data.placeLabel !== undefined ? { placeLabel: data.placeLabel } : {}),
        ...(data.placePrecision !== undefined ? { placePrecision: data.placePrecision } : {}),
      },
    });
    if (result.count === 0) throw new NoteNotFoundError();

    await applyNoteTags(tx, ownerId, noteId, tagNames);

    return tx.note.findFirstOrThrow({ where: { id: noteId, ownerId } });
  });
}
