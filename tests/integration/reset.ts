import type { PrismaClient } from "@prisma/client";

/**
 * Clear every table, in foreign-key-safe order.
 *
 * Shared rather than repeated per file: integration files run serially against
 * one database, so a teardown that misses a table leaves rows that break the
 * *next* file's cleanup. That is exactly what happened when `recording_artists`
 * arrived — a suite written before it existed started failing on an unrelated
 * delete. One list, updated in one place when the schema grows.
 */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.noteTag.deleteMany();
  await prisma.note.deleteMany();
  // Before recordings: a listen references the recording it was imported into.
  await prisma.listen.deleteMany();
  await prisma.collectionItem.deleteMany();
  await prisma.collection.deleteMany();
  await prisma.import.deleteMany();
  await prisma.tag.deleteMany();
  await prisma.recordingArtist.deleteMany();
  await prisma.recordingExternalId.deleteMany();
  await prisma.recording.deleteMany();
  await prisma.albumArtist.deleteMany();
  await prisma.albumExternalId.deleteMany();
  await prisma.album.deleteMany();
  await prisma.artistExternalId.deleteMany();
  await prisma.artist.deleteMany();
  await prisma.authLapse.deleteMany();
  await prisma.identityTombstone.deleteMany();
  await prisma.user.deleteMany();
}
