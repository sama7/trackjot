import { parseTidalLink } from "@/lib/music/tidal/parse-link";
import {
  fetchTidalAlbum,
  fetchTidalPlaylist,
  tidalConfigured,
  TidalUnavailableError,
} from "@/lib/music/tidal/api";
import { importCollection, type ImportSummary } from "@/lib/music/import-collection";

/**
 * Pasting a Tidal album or playlist link and getting a collection.
 *
 * Client credentials read both, so unlike Apple Music there is no split
 * between what works with and without a paid developer account. The two cases
 * that genuinely cannot work — a private playlist, or something not licensed
 * in the configured region — both surface as "not found", and are explained
 * as such with CSV import as the fallback.
 */

export type TidalImportOutcome =
  | { ok: true; summary: ImportSummary }
  | { ok: false; reason: TidalImportRefusal; message: string };

export type TidalImportRefusal =
  | "not-a-collection"
  | "not-configured"
  | "not-found"
  | "rate-limited"
  | "unavailable"
  | "empty";

const CSV_SUGGESTION =
  "You can still bring it in with a CSV export, or start a collection and add tracks by link.";

export async function importFromTidalLink(
  ownerId: string,
  input: string,
  options: {
    fetchAlbumImpl?: typeof fetchTidalAlbum;
    fetchPlaylistImpl?: typeof fetchTidalPlaylist;
  } = {},
): Promise<TidalImportOutcome> {
  const ref = parseTidalLink(input);
  if (ref.kind !== "album" && ref.kind !== "playlist") {
    return { ok: false, reason: "not-a-collection", message: "That isn't a Tidal album or playlist link." };
  }
  const injected = ref.kind === "album" ? options.fetchAlbumImpl : options.fetchPlaylistImpl;
  if (!injected && !tidalConfigured()) {
    return {
      ok: false,
      reason: "not-configured",
      message: `Importing Tidal collections isn't available right now. ${CSV_SUGGESTION}`,
    };
  }

  try {
    const data = await (injected ?? (ref.kind === "album" ? fetchTidalAlbum : fetchTidalPlaylist))(ref.id);
    if (!data) {
      return {
        ok: false,
        reason: "not-found",
        message:
          ref.kind === "playlist"
            ? `Tidal won't share that playlist — it may be private, or not available in this region. ${CSV_SUGGESTION}`
            : `Tidal doesn't have that album available in this region. ${CSV_SUGGESTION}`,
      };
    }
    if (data.tracks.length === 0) {
      return {
        ok: false,
        reason: "empty",
        message: "That collection came back empty, so there was nothing to import.",
      };
    }
    return { ok: true, summary: await importCollection(ownerId, data) };
  } catch (error) {
    if (!(error instanceof TidalUnavailableError)) throw error;
    return error.reason === "rate-limited"
      ? { ok: false, reason: "rate-limited", message: "Tidal is busy right now. Try again in a minute." }
      : { ok: false, reason: "unavailable", message: `We couldn't reach Tidal just now. ${CSV_SUGGESTION}` };
  }
}
