import { Provider } from "@prisma/client";
import { prisma } from "@/lib/db";
import { resolveImportableTrack } from "@/lib/music/persist-track";
import {
  fromAppleCollection,
  fromSpotifyCollection,
  type ImportableCollection,
} from "@/lib/music/importable";
import {
  SpotifyUnavailableError,
  fetchAlbum,
  fetchPlaylist,
  spotifyConfigured,
} from "@/lib/music/spotify/web-api";
import { parseSpotifyLink } from "@/lib/music/spotify/parse-link";
import { parseAppleMusicLink } from "@/lib/music/apple/parse-link";
import { fetchAppleAlbum } from "@/lib/music/apple/itunes";
import { fetchAppleAlbumCatalog, fetchApplePlaylistCatalog } from "@/lib/music/apple/catalog";
import { appleMusicConfigured } from "@/lib/music/apple/developer-token";
import { AppleMusicUnavailableError } from "@/lib/music/apple/music-api";
import { fetchTidalAlbum, fetchTidalPlaylist, tidalConfigured, TidalUnavailableError } from "@/lib/music/tidal/api";
import { parseTidalLink } from "@/lib/music/tidal/parse-link";
import { providerLabel } from "@/lib/notes/list";
import {
  applyReconciliation,
  planReconciliation,
  type ReconcileMode,
  type ReconciliationPlan,
} from "./reconcile";
import { CollectionNotFoundError } from "./service";

/**
 * Re-reading a collection from its source, and merging a CSV into an existing
 * one.
 *
 * Both go through the same two phases, and the split is the point:
 *
 *   1. **Plan** — fetch or parse, resolve recordings, and compute what would
 *      change. Nothing is written. The result names the notes that would lose
 *      their slot, so the user is shown the cost *before* agreeing to it.
 *   2. **Apply** — one transaction, driven by the plan.
 *
 * A destructive operation that cannot be previewed is one people only
 * understand after it is too late, and "your note about track 7 will come
 * unstuck" is exactly the kind of thing they would want to know first.
 */

export interface RefreshPreview {
  collectionId: string;
  name: string;
  /** Where the new tracklist came from, for the confirmation copy. */
  sourceLabel: string;
  added: number;
  removed: number;
  moved: number;
  unchanged: number;
  total: number;
  truncated: boolean;
  /** Notes that would be un-anchored. Shown in full — never summarised away. */
  orphaning: Array<{ id: string; body: string; trackTitle: string }>;
}

/** The source could not be re-read. Distinct from "the collection has none". */
export class SourceUnavailableError extends Error {
  constructor() {
    super("Source unavailable");
    this.name = "SourceUnavailableError";
  }
}

export type RefreshOutcome =
  | { ok: true; preview: RefreshPreview; applied: boolean }
  | { ok: false; message: string };

/** Everything the plan phase needs, independent of where the tracks came from. */
interface ResolvedSource {
  recordingIds: string[];
  truncated: boolean;
  label: string;
}

/**
 * Read the collection's own items and the notes anchored to them.
 *
 * Ordered by position, because occurrence numbering depends on it — a caller
 * that sorted differently would re-anchor notes to the wrong copy of a repeated
 * track, which is precisely the failure this whole module exists to prevent.
 */
async function loadExisting(ownerId: string, collectionId: string) {
  const collection = await prisma.collection.findFirst({
    where: { id: collectionId, ownerId },
    include: {
      items: {
        orderBy: { position: "asc" },
        include: {
          recording: { select: { title: true } },
          notes: { where: { ownerId }, select: { id: true, body: true, updatedAt: true } },
        },
      },
    },
  });
  if (!collection) throw new CollectionNotFoundError();
  return collection;
}

type ExistingCollection = Awaited<ReturnType<typeof loadExisting>>;

function buildPlan(
  collection: ExistingCollection,
  recordingIds: string[],
  mode: ReconcileMode,
): { plan: ReconciliationPlan; orphaning: RefreshPreview["orphaning"] } {
  const plan = planReconciliation(
    collection.items.map((item) => ({
      id: item.id,
      recordingId: item.recordingId,
      position: item.position,
      notes: item.notes.map((n) => ({ id: n.id, updatedAt: n.updatedAt })),
    })),
    recordingIds.map((recordingId) => ({ recordingId })),
    mode,
  );

  const orphanIds = new Set(plan.orphanedNoteIds);
  const orphaning = collection.items.flatMap((item) =>
    item.notes
      .filter((n) => orphanIds.has(n.id))
      .map((n) => ({ id: n.id, body: n.body, trackTitle: item.recording.title })),
  );

  return { plan, orphaning };
}

/**
 * Re-read the tracklist from the provider this collection came from.
 *
 * `apply: false` previews; `apply: true` writes. The same call computes both,
 * so the thing the user confirmed is the thing that runs.
 */
export async function refreshCollection(
  ownerId: string,
  collectionId: string,
  options: { apply: boolean } = { apply: false },
): Promise<RefreshOutcome> {
  const collection = await loadExisting(ownerId, collectionId);

  if (!collection.sourceProvider || !collection.sourceId) {
    return {
      ok: false,
      message:
        "This collection didn't come from a link, so there's no source to re-read. Import a CSV into it instead.",
    };
  }

  let source: ResolvedSource;
  try {
    source = await fetchSource(
      collection.sourceProvider,
      collection.sourceId,
      collection.sourceUrl,
    );
  } catch (error) {
    if (error instanceof SourceUnavailableError) {
      return {
        ok: false,
        message:
          "We couldn't read that playlist again just now — it may have been made private or deleted. Nothing was changed.",
      };
    }
    if (error instanceof AppleMusicUnavailableError) {
      return { ok: false, message: "We couldn't reach Apple Music just now. Nothing was changed." };
    }
    throw error;
  }

  const { plan, orphaning } = buildPlan(collection, source.recordingIds, "replace");

  const preview: RefreshPreview = {
    collectionId: collection.id,
    name: collection.name,
    sourceLabel: source.label,
    added: plan.added,
    removed: plan.removed,
    moved: plan.moved,
    unchanged: plan.unchanged,
    total: plan.items.length,
    truncated: source.truncated,
    orphaning,
  };

  if (!options.apply) return { ok: true, preview, applied: false };

  await prisma.$transaction(
    async (tx) => {
      await applyReconciliation(tx, collection.id, plan);
      await tx.collection.update({
        where: { id: collection.id },
        data: {
          refreshedAt: new Date(),
          refreshCount: { increment: 1 },
          sourceSnapshotAt: new Date(),
          artworkUrl: collection.artworkUrl,
        },
      });
    },
    { timeout: 30_000 },
  );

  return { ok: true, preview, applied: true };
}

/**
 * Fetch the current tracklist and resolve every track to a recording.
 *
 * Resolution happens **outside** the reconciliation transaction on purpose: it
 * makes network calls and can create catalog rows, and holding a transaction
 * open across provider latency is how a 50-track playlist becomes a lock
 * timeout. Catalog rows are additive and safe to create even if the user then
 * cancels — nothing user-owned is written until they confirm.
 */
async function fetchSource(
  provider: Provider,
  sourceId: string,
  sourceUrl: string | null,
): Promise<ResolvedSource> {
  const data = await fetchCollectionData(provider, sourceId, sourceUrl);
  if (!data) throw new SourceUnavailableError();

  const recordingIds: string[] = [];
  for (const track of data.tracks) {
    const resolved = await resolveImportableTrack(prisma, provider, track);
    recordingIds.push(resolved.recordingId);
  }

  return {
    recordingIds,
    truncated: data.truncated,
    label: providerLabel(provider) ?? "Spotify",
  };
}

async function fetchCollectionData(
  provider: Provider,
  sourceId: string,
  sourceUrl: string | null,
): Promise<ImportableCollection | null> {
  const kind = collectionKind(provider, sourceId, sourceUrl);

  try {
    if (provider === Provider.apple_music) {
      if (appleMusicConfigured()) {
        return kind === "playlist"
          ? await fetchApplePlaylistCatalog(sourceId)
          : await fetchAppleAlbumCatalog(sourceId);
      }
      // No developer token: playlists are out of reach, albums are not.
      if (kind === "playlist") return null;
      const album = await fetchAppleAlbum(sourceId);
      return album ? fromAppleCollection(album, "album") : null;
    }

    if (provider === Provider.tidal) {
      if (!tidalConfigured()) return null;
      return kind === "playlist" ? await fetchTidalPlaylist(sourceId) : await fetchTidalAlbum(sourceId);
    }

    if (!spotifyConfigured()) return null;

    const data =
      kind === "playlist" ? await fetchPlaylist(sourceId) : await fetchAlbum(sourceId);
    return data ? fromSpotifyCollection(data) : null;
  } catch (error) {
    /**
     * A 404 here is the ordinary outcome of a playlist that was deleted or made
     * private, and the caller turns that into a sentence rather than a stack
     * trace. `fetchAlbum` throws rather than returning null on 404, which is
     * why this is a catch and not a null check — an earlier version tried the
     * album endpoint first and let the throw escape as a 500.
     */
    if (error instanceof SpotifyUnavailableError) return null;
    if (error instanceof TidalUnavailableError && error.reason === "not-found") return null;
    throw error;
  }
}

/**
 * Album or playlist, decided from what was stored rather than by probing.
 *
 * The two providers have separate endpoints and the stored id does not say
 * which one it belongs to — but the source URL does, and it was captured at
 * import precisely so questions like this have an answer. Guessing by calling
 * one endpoint and falling back on failure costs a wasted round trip and turns
 * an ordinary 404 into a control-flow exception.
 */
function collectionKind(
  provider: Provider,
  sourceId: string,
  sourceUrl: string | null,
): "album" | "playlist" {
  if (provider === Provider.apple_music) {
    // Apple playlist ids carry a "pl." prefix; album ids are numeric.
    if (sourceId.startsWith("pl.")) return "playlist";
    const ref = sourceUrl ? parseAppleMusicLink(sourceUrl) : null;
    return ref?.kind === "playlist" ? "playlist" : "album";
  }

  if (provider === Provider.tidal) {
    // Tidal playlist ids are UUIDs; album ids are numeric.
    if (sourceId.includes("-")) return "playlist";
    return sourceUrl && parseTidalLink(sourceUrl).kind === "playlist" ? "playlist" : "album";
  }

  const ref = sourceUrl ? parseSpotifyLink(sourceUrl) : null;
  return ref?.kind === "playlist" ? "playlist" : "album";
}

/**
 * Apply an already-parsed CSV to an existing collection.
 *
 * `replace` is the default because it matches what a re-export means: this file
 * is the playlist now. `append` exists because "add these to what I have" is a
 * different and equally real intention, and guessing between them from the file
 * contents would be guessing.
 */
export async function applyCsvToCollection(
  ownerId: string,
  collectionId: string,
  data: ImportableCollection,
  mode: ReconcileMode,
  options: { apply: boolean; filename?: string | null; contentHash?: string | null } = {
    apply: false,
  },
): Promise<RefreshOutcome> {
  const collection = await loadExisting(ownerId, collectionId);

  const recordingIds: string[] = [];
  for (const track of data.tracks) {
    const resolved = await resolveImportableTrack(prisma, data.provider, track);
    recordingIds.push(resolved.recordingId);
  }

  const { plan, orphaning } = buildPlan(collection, recordingIds, mode);

  const preview: RefreshPreview = {
    collectionId: collection.id,
    name: collection.name,
    sourceLabel: options.filename ? `the file ${options.filename}` : "your CSV",
    added: plan.added,
    removed: plan.removed,
    moved: plan.moved,
    unchanged: plan.unchanged,
    total: plan.items.length,
    truncated: data.truncated,
    orphaning,
  };

  if (!options.apply) return { ok: true, preview, applied: false };

  await prisma.$transaction(
    async (tx) => {
      const record = await tx.import.create({
        data: {
          ownerId,
          provider: data.provider,
          filename: options.filename ?? null,
          contentHash: options.contentHash ?? null,
          status: "completed",
          rowCount: data.tracks.length,
        },
      });
      await applyReconciliation(tx, collection.id, plan);
      await tx.collection.update({
        where: { id: collection.id },
        data: {
          importId: record.id,
          refreshedAt: new Date(),
          refreshCount: { increment: 1 },
        },
      });
    },
    { timeout: 30_000 },
  );

  return { ok: true, preview, applied: true };
}
