import { PrismaClient, Provider, RecordingOrigin } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createNote, NoteNotFoundError } from "@/lib/notes/service";
import { EmptyNoteError, saveNoteEdit } from "@/lib/notes/edit";
import { setNoteTags } from "@/lib/notes/tags";
import { resetDatabase } from "./reset";

const prisma = new PrismaClient();

/**
 * Saving the note editor: words and tags together, or not at all.
 *
 * It used to be two writes from one form — update the note, then set its tags —
 * and the editor closed once both settled, whether or not either had landed.
 * An empty body was silently skipped and the editor closed as though it had
 * saved. These tests pin the replacement: validate first, write once.
 */

async function makeUser() {
  return prisma.user.create({ data: { authSubject: `s_${crypto.randomUUID()}` } });
}

async function makeNote(ownerId: string) {
  const recording = await prisma.recording.create({
    data: {
      title: "CN TOWER",
      artistDisplay: "Test Artist",
      origin: RecordingOrigin.provider,
      normalizedKey: `k_${crypto.randomUUID()}`,
      externalIds: { create: { provider: Provider.spotify, providerId: `p_${crypto.randomUUID()}` } },
    },
  });
  return createNote(ownerId, { recordingId: recording.id, body: "the original words" });
}

async function tagsOf(noteId: string) {
  const rows = await prisma.noteTag.findMany({
    where: { noteId },
    include: { tag: { select: { name: true } } },
  });
  return rows.map((r) => r.tag.name).sort();
}

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("saving an edit", () => {
  it("stores the words and the tags in one go", async () => {
    const user = await makeUser();
    const note = await makeNote(user.id);

    await saveNoteEdit(user.id, note.id, { body: "new words" }, ["qawwali", "late night"]);

    const stored = await prisma.note.findUniqueOrThrow({ where: { id: note.id } });
    expect(stored.body).toBe("new words");
    expect(await tagsOf(note.id)).toEqual(["late night", "qawwali"]);
  });

  /** The silent skip, stated as a test: refused, and nothing written. */
  it("refuses an empty body and changes nothing — not even the tags", async () => {
    const user = await makeUser();
    const note = await makeNote(user.id);
    await setNoteTags(user.id, note.id, ["kept"]);

    await expect(
      saveNoteEdit(user.id, note.id, { body: "   " }, ["should not appear"]),
    ).rejects.toBeInstanceOf(EmptyNoteError);

    const stored = await prisma.note.findUniqueOrThrow({ where: { id: note.id } });
    expect(stored.body).toBe("the original words");
    expect(await tagsOf(note.id)).toEqual(["kept"]);
  });

  /**
   * Somebody else's note, addressed by its real id: reported missing, and not
   * one byte of it touched — including the tags, which used to be a separate
   * write that could land on its own.
   */
  it("treats another member's note as missing and leaves it alone", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const note = await makeNote(owner.id);
    await setNoteTags(owner.id, note.id, ["theirs"]);

    await expect(
      saveNoteEdit(stranger.id, note.id, { body: "defaced" }, ["mine now"]),
    ).rejects.toBeInstanceOf(NoteNotFoundError);

    const stored = await prisma.note.findUniqueOrThrow({ where: { id: note.id } });
    expect(stored.body).toBe("the original words");
    expect(await tagsOf(note.id)).toEqual(["theirs"]);
    expect(await prisma.tag.count({ where: { ownerId: stranger.id } })).toBe(0);
  });

  it("clears tags when the field is emptied", async () => {
    const user = await makeUser();
    const note = await makeNote(user.id);
    await setNoteTags(user.id, note.id, ["gone soon"]);

    await saveNoteEdit(user.id, note.id, { body: "still here" }, []);

    expect(await tagsOf(note.id)).toEqual([]);
  });
});
