import { Prisma, type DatePrecision, type PlacePrecision, type Visibility } from "@prisma/client";
import { trackUrl } from "@/lib/music/provider-url";
import { formatExperienced } from "@/lib/format-date";

/**
 * The shape a note takes in a list, and the one query that produces it.
 *
 * The notes page, the tag filter and the collection page all render the same
 * card, and each was building its own `include` — so adding artwork or a
 * collection subject meant remembering three call sites, and forgetting one
 * produced a card with a missing cover rather than a type error. One include
 * and one mapper means the row component has exactly one contract to satisfy.
 */

export const NOTE_LIST_INCLUDE = {
  recording: {
    include: {
      externalIds: { take: 1 },
      // Title for display, artwork as a fallback: a recording created before we
      // stored covers falls back to its album's, which is usually the same image.
      album: { select: { title: true, artworkThumbUrl: true, artworkUrl: true } },
    },
  },
  collection: { select: { id: true, name: true, artworkThumbUrl: true, artworkUrl: true } },
  // Playlist context — "this track, third into that playlist".
  collectionItem: { select: { collection: { select: { id: true, name: true } } } },
  tags: { include: { tag: { select: { name: true } } } },
} satisfies Prisma.NoteInclude;

export type NoteWithSubject = Prisma.NoteGetPayload<{ include: typeof NOTE_LIST_INCLUDE }>;

/** What a note card renders. Deliberately flat — the row does no joining. */
export interface NoteRowData {
  id: string;
  body: string;
  visibility: Visibility;
  shareToken: string | null;
  createdAt: Date;
  updatedAt: Date;
  title: string;
  artist: string | null;
  albumTitle: string | null;
  artworkThumbUrl: string | null;
  artworkUrl: string | null;
  providerUrl: string | null;
  /** Which service the link goes to, for an honest "Open in …" label. */
  providerName: string | null;
  /** Already rendered at its stated precision — see formatExperienced. */
  experiencedLabel: string | null;
  experiencedAt: Date | null;
  experiencedPrecision: DatePrecision | null;
  placeLabel: string | null;
  placePrecision: PlacePrecision | null;
  /** Set when the note is about a collection rather than a track. */
  collection: { id: string; name: string } | null;
  /** Set when the note is about a track *inside* a collection. */
  context: { id: string; name: string } | null;
  tags: string[];
}

/**
 * A note is about exactly one of a recording or a collection — the database
 * CHECK guarantees it — so this reads whichever one is present. The per-note
 * display override wins over the shared recording, which is what stops one
 * user's correction from changing what another user saved.
 */
export function toNoteRow(note: NoteWithSubject): NoteRowData {
  const recording = note.recording;
  const collection = note.collection;

  return {
    id: note.id,
    body: note.body,
    visibility: note.visibility,
    shareToken: note.shareToken,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    title: note.displayTitle ?? recording?.title ?? collection?.name ?? "Untitled",
    artist: note.displayArtist ?? recording?.artistDisplay ?? null,
    // The album row where it was linked, the denormalized string where it was
    // not. A track captured with no album linkage still says what it came from.
    albumTitle: recording?.album?.title ?? recording?.releaseTitle ?? null,
    artworkThumbUrl:
      recording?.artworkThumbUrl ??
      recording?.album?.artworkThumbUrl ??
      collection?.artworkThumbUrl ??
      // Falling back to the full rendition is right when no thumb was stored:
      // slightly heavier, and crisp, rather than absent.
      recording?.artworkUrl ??
      recording?.album?.artworkUrl ??
      collection?.artworkUrl ??
      null,
    artworkUrl:
      recording?.artworkUrl ?? recording?.album?.artworkUrl ?? collection?.artworkUrl ?? null,
    providerUrl: trackUrl(recording?.externalIds[0]),
    providerName: providerLabel(recording?.externalIds[0]?.provider ?? null),
    experiencedLabel: formatExperienced(note.experiencedAt, note.experiencedPrecision),
    experiencedAt: note.experiencedAt,
    experiencedPrecision: note.experiencedPrecision,
    placeLabel: note.placeLabel,
    placePrecision: note.placePrecision,
    collection: collection ? { id: collection.id, name: collection.name } : null,
    context: note.collectionItem?.collection
      ? {
          id: note.collectionItem.collection.id,
          name: note.collectionItem.collection.name,
        }
      : null,
    tags: note.tags.map((t) => t.tag.name),
  };
}

/**
 * "Open in Spotify" rather than "Open the original".
 *
 * The generic wording made the user guess where a link would take them, and the
 * database already knows. Unmapped providers fall back to null so the caller can
 * omit the link entirely rather than print an enum value at somebody.
 */
export function providerLabel(provider: string | null): string | null {
  switch (provider) {
    case "spotify":
      return "Spotify";
    case "apple_music":
      return "Apple Music";
    case "deezer":
      return "Deezer";
    case "tidal":
      return "Tidal";
    case "musicbrainz":
      return "MusicBrainz";
    case "discogs":
      return "Discogs";
    default:
      return null;
  }
}
