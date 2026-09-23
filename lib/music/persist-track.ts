import { Prisma, Provider, RecordingOrigin } from "@prisma/client";
import { canonicalTrackUrl } from "@/lib/music/provider-url";
import { normalizedKey } from "@/lib/music/normalize";
import type { ImportableArtist, ImportableTrack } from "./importable";

/**
 * Turning one provider-described track into rows.
 *
 * This was inside import-collection.ts, reachable only by importing a whole
 * album or playlist. Pasting a single track link went down a much poorer path
 * that stored a title and a display string and linked nothing — so the same
 * song produced a rich row when it arrived inside an album and a bare one when
 * pasted on its own. Extracting it means there is exactly one definition of
 * what a provider-anchored recording looks like, whichever door it came in by.
 *
 * Every function takes a `db` handle rather than importing the client, so a
 * collection import can pass its transaction and keep atomicity while a single
 * capture passes the plain client and skips the transaction it does not need.
 *
 * The catalog rule this enforces (AGENTS.md §3a): **entities come from
 * identifiers, never from names.** Artists and albums are resolved by provider
 * ID. Display strings are stored for rendering and never split, parsed, or
 * matched on.
 */

/** `PrismaClient` satisfies this too, so callers choose whether to be atomic. */
export type Db = Prisma.TransactionClient;

/** Upsert an artist by provider ID. Never creates from a name. */
export async function resolveArtist(
  db: Db,
  provider: Provider,
  ref: ImportableArtist,
): Promise<string> {
  const existing = await db.artistExternalId.findUnique({
    where: { provider_providerId: { provider, providerId: ref.providerId } },
    select: { artistId: true },
  });
  if (existing) return existing.artistId;

  const artist = await db.artist.create({
    data: {
      name: ref.name,
      sortName: ref.name,
      externalIds: { create: { provider, providerId: ref.providerId } },
    },
  });
  return artist.id;
}

export async function resolveAlbum(
  db: Db,
  provider: Provider,
  album: NonNullable<ImportableTrack["album"]>,
): Promise<string> {
  const existing = await db.albumExternalId.findUnique({
    where: { provider_providerId: { provider, providerId: album.providerId } },
    select: { albumId: true },
  });
  if (existing) return existing.albumId;

  const artistIds = await Promise.all(album.artists.map((a) => resolveArtist(db, provider, a)));

  const created = await db.album.create({
    data: {
      title: album.name,
      artistDisplay: album.artists.map((a) => a.name).join(", ") || null,
      releaseDate: parseReleaseDate(album.releaseDate),
      artworkUrl: album.artwork?.url ?? null,
      artworkThumbUrl: album.artwork?.thumbUrl ?? null,
      sourceMetadata: {
        provider,
        albumArtistIds: album.artists.map((a) => a.providerId),
        retrievedAt: new Date().toISOString(),
      },
      externalIds: { create: { provider, providerId: album.providerId } },
      artists: { create: artistIds.map((artistId, position) => ({ artistId, position })) },
    },
  });
  return created.id;
}

/** Providers give release dates as YYYY, YYYY-MM or YYYY-MM-DD. */
export function parseReleaseDate(value: string | null): Date | null {
  if (!value) return null;
  const parts = value.split("-");
  const [y, m, d] = [parts[0], parts[1] ?? "01", parts[2] ?? "01"];
  const date = new Date(`${y}-${m}-${d}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface ResolvedTrack {
  recordingId: string;
  wasCreated: boolean;
}

export async function resolveImportableTrack(
  db: Db,
  provider: Provider,
  track: ImportableTrack,
): Promise<ResolvedTrack> {
  const existing = await db.recordingExternalId.findUnique({
    where: { provider_providerId: { provider, providerId: track.providerId } },
    select: { recordingId: true },
  });
  if (existing) return { recordingId: existing.recordingId, wasCreated: false };

  const albumId = track.album ? await resolveAlbum(db, provider, track.album) : null;
  const artistIds = await Promise.all(track.artists.map((a) => resolveArtist(db, provider, a)));

  try {
    const recording = await db.recording.create({
      data: {
        title: track.name,
        artistDisplay: track.artistDisplay,
        origin: RecordingOrigin.provider,
        normalizedKey: normalizedKey({
          title: track.name,
          artistDisplay: track.artistDisplay,
          durationMs: track.durationMs,
        }),
        durationMs: track.durationMs,
        // Denormalized from the album so a track row renders without a join,
        // and so a track with no album row still has a picture.
        artworkUrl: track.artwork?.url ?? track.album?.artwork?.url ?? null,
        artworkThumbUrl: track.artwork?.thumbUrl ?? track.album?.artwork?.thumbUrl ?? null,
        albumId,
        releaseTitle: track.album?.name ?? null,
        releaseDate: parseReleaseDate(track.album?.releaseDate ?? null),
        externalIds: {
          create: {
            provider,
            providerId: track.providerId,
            providerUrl: canonicalTrackUrl(provider, track.providerId),
            isrc: track.isrc,
            sourceMetadata: {
              artistIds: track.artists.map((a) => a.providerId),
              trackNumber: track.trackNumber,
            },
          },
        },
        artists: { create: artistIds.map((artistId, position) => ({ artistId, position })) },
      },
    });
    return { recordingId: recording.id, wasCreated: true };
  } catch (error) {
    /**
     * Two people can paste the same new track at the same instant. The unique
     * index on (provider, provider_id) settles it and the loser re-reads.
     *
     * Only reachable on the non-transactional path — inside a transaction the
     * conflict aborts the whole import, which is the behaviour that path wants.
     */
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await db.recordingExternalId.findUniqueOrThrow({
        where: { provider_providerId: { provider, providerId: track.providerId } },
        select: { recordingId: true },
      });
      return { recordingId: winner.recordingId, wasCreated: false };
    }
    throw error;
  }
}
