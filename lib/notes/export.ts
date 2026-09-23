import { prisma } from "@/lib/db";
import { trackUrl } from "@/lib/music/provider-url";
import { formatExperienced, formatDay } from "@/lib/format-date";

/**
 * Taking your notes with you.
 *
 * This is a product feature, not housekeeping. TrackJot's whole pitch is that a
 * journal you keep for years should not belong to whoever is hosting it — and
 * that claim is only worth making if leaving is a button rather than a support
 * request. So: three formats, everything the user wrote, no account required to
 * read the result.
 *
 *   - **JSON** is the complete record, including ids and precision flags, meant
 *     for re-importing or for a script.
 *   - **CSV** is for a spreadsheet, so it flattens tags to a single column and
 *     drops nothing.
 *   - **Markdown** is for reading — the format that still opens in thirty years
 *     with no software at all.
 *
 * Every query here is owner-scoped in its WHERE clause. An export is the single
 * largest disclosure the product performs, so it is the last place to rely on
 * filtering after the fact.
 */

export async function collectExport(ownerId: string) {
  const notes = await prisma.note.findMany({
    where: { ownerId },
    orderBy: { createdAt: "asc" },
    include: {
      recording: {
        select: {
          id: true,
          title: true,
          artistDisplay: true,
          releaseTitle: true,
          origin: true,
          album: { select: { title: true } },
          externalIds: { select: { provider: true, providerId: true, providerUrl: true } },
        },
      },
      collection: { select: { name: true } },
      collectionItem: { select: { position: true, collection: { select: { name: true } } } },
      tags: { include: { tag: { select: { name: true } } } },
    },
  });

  return notes.map((note) => ({
    id: note.id,
    body: note.body,
    visibility: note.visibility,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
    experiencedAt: note.experiencedAt?.toISOString() ?? null,
    experiencedPrecision: note.experiencedPrecision,
    place: note.placeLabel,
    placePrecision: note.placePrecision,
    // Coordinates are included: they are the user's own data and this is the
    // user asking for it. They are simply never *published*.
    placeLat: note.placeLat ? Number(note.placeLat) : null,
    placeLon: note.placeLon ? Number(note.placeLon) : null,
    track: note.recording?.title ?? null,
    artist: note.recording?.artistDisplay ?? null,
    album: note.recording?.album?.title ?? note.recording?.releaseTitle ?? null,
    /**
     * What the export promises is a record you could rebuild from, and a bare
     * list of URLs is not that. These three were missing:
     *
     *   - `recordingId` — the TrackJot UUID, which is what makes two exported
     *     notes about the same track recognisably about the same track.
     *   - `providerIds` — provider and identifier as a pair. A URL is a
     *     rendering of an identifier and can change; the pair is the fact.
     *   - the display overrides — the title and artist *this writer* chose to
     *     see. Dropping them exports somebody else's words for their note.
     *
     * `recordingOrigin` comes along because it says whether the row is shared
     * catalog or this person's own entry, which decides what a re-import may do
     * with it.
     */
    recordingId: note.recording?.id ?? null,
    recordingOrigin: note.recording?.origin ?? null,
    displayTitle: note.displayTitle,
    displayArtist: note.displayArtist,
    providerIds:
      note.recording?.externalIds.map((e) => ({
        provider: e.provider,
        providerId: e.providerId,
        url: trackUrl(e),
      })) ?? [],
    links: note.recording?.externalIds.map((e) => trackUrl(e)).filter(Boolean) ?? [],
    aboutCollection: note.collection?.name ?? null,
    inCollection: note.collectionItem?.collection.name ?? null,
    positionInCollection: note.collectionItem ? note.collectionItem.position + 1 : null,
    tags: note.tags.map((t) => t.tag.name),
  }));
}

export type ExportedNote = Awaited<ReturnType<typeof collectExport>>[number];

export function toJson(notes: ExportedNote[]): string {
  return JSON.stringify(
    { exportedAt: new Date().toISOString(), format: "trackjot.notes.v1", notes },
    null,
    2,
  );
}

const CSV_COLUMNS = [
  "id",
  "track",
  "artist",
  "album",
  "note",
  "tags",
  "experienced_at",
  "experienced_precision",
  "place",
  "in_collection",
  "position_in_collection",
  "about_collection",
  "visibility",
  "created_at",
  "updated_at",
  "links",
] as const;

/**
 * RFC 4180 quoting: every field is quoted and inner quotes are doubled.
 *
 * Quoting unconditionally rather than only when it looks necessary — a note body
 * contains commas, newlines and quotation marks as a matter of course, and
 * "quote it if it has a comma" is the rule that produces a file which opens
 * correctly until the day somebody writes a sentence with a line break in it.
 */
function csvField(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : Array.isArray(value)
        ? value.join("; ")
        : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(notes: ExportedNote[]): string {
  const rows = notes.map((n) =>
    [
      n.id,
      n.track,
      n.artist,
      n.album,
      n.body,
      n.tags,
      n.experiencedAt,
      n.experiencedPrecision,
      n.place,
      n.inCollection,
      n.positionInCollection,
      n.aboutCollection,
      n.visibility,
      n.createdAt,
      n.updatedAt,
      n.links,
    ]
      .map(csvField)
      .join(","),
  );
  return [CSV_COLUMNS.join(","), ...rows].join("\r\n");
}

export function toMarkdown(notes: ExportedNote[]): string {
  const lines: string[] = ["# My TrackJot notes", "", `Exported ${formatDay(new Date())}.`, ""];

  for (const note of notes) {
    const heading = note.track
      ? `${note.track}${note.artist ? ` — ${note.artist}` : ""}`
      : (note.aboutCollection ?? "Untitled");
    lines.push(`## ${heading}`, "");

    const facts: string[] = [];
    if (note.album) facts.push(`Album: ${note.album}`);
    if (note.inCollection) {
      facts.push(`In: ${note.inCollection}${note.positionInCollection ? ` (#${note.positionInCollection})` : ""}`);
    }
    const heard = formatExperienced(note.experiencedAt, note.experiencedPrecision);
    if (heard) facts.push(`Heard: ${heard}`);
    if (note.place) facts.push(`Place: ${note.place}`);
    facts.push(`Written: ${formatDay(note.createdAt)}`);
    if (note.tags.length > 0) facts.push(`Tags: ${note.tags.join(", ")}`);
    lines.push(facts.map((f) => `- ${f}`).join("\n"), "");

    lines.push(note.body, "");
    for (const link of note.links) lines.push(`[Listen](${link})`, "");
  }

  return lines.join("\n");
}
