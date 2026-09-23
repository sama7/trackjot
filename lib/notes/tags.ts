import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NOTE_LIST_INCLUDE } from "@/lib/notes/list";
import { NoteNotFoundError } from "@/lib/notes/service";

/**
 * Tags, scoped to the person who wrote them.
 *
 * The unique constraint is `(owner_id, name)`, not `name`, and that is the whole
 * design. A shared tag vocabulary would make one user's labels visible to
 * another the moment autocomplete existed, and "chill" meaning one thing to you
 * and another to someone else is not a conflict worth resolving — it is two
 * private filing systems that happen to use the same word.
 *
 * Tags are therefore free text, normalised only for matching, and never
 * promoted into anything shared. That is the same rule the catalog policy
 * applies to user-authored recordings (AGENTS.md §3a.5), for the same reason.
 */

const MAX_TAGS_PER_NOTE = 12;
const MAX_TAG_LENGTH = 40;

/**
 * Fold case and collapse whitespace so "Late Night" and "late  night" are one
 * tag, while leaving everything else alone — stripping punctuation would merge
 * tags a user deliberately distinguished.
 */
export function normalizeTagName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase().slice(0, MAX_TAG_LENGTH);
}

/** Split what a user typed into distinct tag names, in the order given. */
export function parseTagInput(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of raw.split(",")) {
    const name = normalizeTagName(piece);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= MAX_TAGS_PER_NOTE) break;
  }
  return out;
}

/**
 * Replace a note's tags with exactly this set.
 *
 * Replace rather than merge: the input is the full contents of a text field, so
 * a name the user removed from it must actually go away. Everything runs in one
 * transaction so a note is never briefly untagged.
 */
export async function setNoteTags(
  ownerId: string,
  noteId: string,
  names: string[],
): Promise<string[]> {
  return prisma.$transaction((tx) => applyNoteTags(tx, ownerId, noteId, names));
}

/**
 * The body of `setNoteTags`, runnable inside a caller's transaction.
 *
 * Split out so that editing a note can save its words and its tags as **one**
 * atomic write. They used to be two actions fired back to back from the same
 * form, which meant the note could be saved and its tags not — or the reverse —
 * with nothing to tell the writer which half had landed.
 */
export async function applyNoteTags(
  tx: Prisma.TransactionClient,
  ownerId: string,
  noteId: string,
  names: string[],
): Promise<string[]> {
  const wanted = parseTagInput(names.join(","));

  // Owner-scoped: a valid note id belonging to someone else resolves to
  // nothing and is reported as missing, exactly like a deleted note.
  const note = await tx.note.findFirst({ where: { id: noteId, ownerId }, select: { id: true } });
  if (!note) throw new NoteNotFoundError();

  const tagIds: string[] = [];
  for (const name of wanted) {
    const tag = await tx.tag.upsert({
      where: { ownerId_name: { ownerId, name } },
      create: { ownerId, name },
      update: {},
      select: { id: true },
    });
    tagIds.push(tag.id);
  }

  await tx.noteTag.deleteMany({ where: { noteId, tagId: { notIn: tagIds } } });
  if (tagIds.length > 0) {
    await tx.noteTag.createMany({
      data: tagIds.map((tagId) => ({ noteId, tagId })),
      skipDuplicates: true,
    });
  }

  /**
   * Drop tags this user no longer uses anywhere. Without this the tag list
   * only ever grows, and a filter menu full of labels attached to nothing is
   * worse than no menu. Scoped to this owner, so it cannot touch anyone else's.
   */
  await tx.tag.deleteMany({ where: { ownerId, notes: { none: {} } } });

  /**
   * Tags live in a join table, so retagging never touched the note row and
   * "edited" silently ignored it. Changing a note's tags IS editing the note —
   * unlike changing its visibility, which deliberately does not count.
   */
  await tx.note.update({ where: { id: note.id }, data: { updatedAt: new Date() } });

  return wanted;
}

export async function listTags(ownerId: string): Promise<Array<{ name: string; count: number }>> {
  const tags = await prisma.tag.findMany({
    where: { ownerId },
    select: { name: true, _count: { select: { notes: true } } },
    orderBy: { name: "asc" },
  });
  return tags.map((t) => ({ name: t.name, count: t._count.notes }));
}

/**
 * Rename a tag everywhere it is used.
 *
 * Renaming onto a name the user already has is a **merge**, not an error: they
 * typed "late-night" and "late night" over six months and now want one tag, and
 * refusing would leave them deleting notes' tags by hand. The merge re-points
 * the note links and drops the emptied row, all in one transaction so no note is
 * briefly untagged.
 */
export async function renameTag(
  ownerId: string,
  from: string,
  to: string,
): Promise<string | null> {
  const oldName = normalizeTagName(from);
  const newName = normalizeTagName(to);
  if (!oldName || !newName || oldName === newName) return null;

  return prisma.$transaction(async (tx) => {
    const source = await tx.tag.findUnique({
      where: { ownerId_name: { ownerId, name: oldName } },
      select: { id: true },
    });
    if (!source) return null;

    const target = await tx.tag.findUnique({
      where: { ownerId_name: { ownerId, name: newName } },
      select: { id: true },
    });

    if (!target) {
      await tx.tag.update({ where: { id: source.id }, data: { name: newName } });
      return newName;
    }

    // Merging. `skipDuplicates` covers notes that already carry both tags —
    // without it the composite primary key would abort the whole rename.
    const links = await tx.noteTag.findMany({
      where: { tagId: source.id },
      select: { noteId: true },
    });
    await tx.noteTag.createMany({
      data: links.map((l) => ({ noteId: l.noteId, tagId: target.id })),
      skipDuplicates: true,
    });
    await tx.tag.delete({ where: { id: source.id } });
    return newName;
  });
}

/**
 * Delete a tag, and its links to notes. The notes themselves are untouched —
 * removing a label must never remove the writing it was attached to.
 */
export async function deleteTag(ownerId: string, name: string): Promise<void> {
  const tagName = normalizeTagName(name);
  if (!tagName) return;
  // Owner-scoped in the WHERE clause, so another user's identically named tag
  // is out of reach rather than merely unlikely to be addressed.
  await prisma.tag.deleteMany({ where: { ownerId, name: tagName } });
}

/** Notes carrying a given tag, owner-scoped at both ends. */
export async function notesByTag(ownerId: string, tagName: string) {
  const name = normalizeTagName(tagName);
  if (!name) return [];

  return prisma.note.findMany({
    where: { ownerId, tags: { some: { tag: { ownerId, name } } } },
    orderBy: { updatedAt: "desc" },
    include: NOTE_LIST_INCLUDE,
    take: 100,
  });
}
