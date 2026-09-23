import { Provider } from "@prisma/client";
import { prisma } from "@/lib/db";
import { parseSpotifyLink } from "@/lib/music/spotify/parse-link";
import { resolveSpotifyShortLink } from "@/lib/music/spotify/resolve-short-link";
import { fetchAlbum, fetchPlaylist, fetchTrack, spotifyConfigured } from "@/lib/music/spotify/web-api";
import { parseAppleMusicLink } from "@/lib/music/apple/parse-link";
import { fetchAppleAlbum, fetchAppleTrack } from "@/lib/music/apple/itunes";
import { fetchAppleAlbumCatalog, fetchApplePlaylistCatalog } from "@/lib/music/apple/catalog";
import { appleMusicConfigured } from "@/lib/music/apple/developer-token";
import { AppleMusicUnavailableError } from "@/lib/music/apple/music-api";
import { NO_ARTWORK, type Artwork } from "@/lib/music/artwork";
import { parseTidalLink, type TidalRef } from "@/lib/music/tidal/parse-link";
import {
  fetchTidalAlbum,
  fetchTidalPlaylist,
  fetchTidalTrack,
  tidalConfigured,
  TidalUnavailableError,
} from "@/lib/music/tidal/api";

/**
 * Look at a pasted link and say what it is — **without creating anything**.
 *
 * The capture form used to ask for a note before it knew what had been pasted,
 * so a playlist link offered a note box that could never be saved, and a track
 * link asked for a title the provider was about to supply anyway. Both are the
 * same mistake: writing before reading.
 *
 * So resolution is now a separate, side-effect-free step. Paste, see what it is
 * and what it looks like, then decide. A track offers a note; a collection
 * offers to be imported. Nothing is written until that second action.
 *
 * ## The database is still consulted first
 *
 * Preview keeps the rate-limit guarantee that capture has: a recording we
 * already hold is answered from PostgreSQL with **no provider call**, so
 * pasting the same link repeatedly costs nothing. Only an unknown identifier
 * reaches the network, and even then nothing is persisted — a user who pastes a
 * link and walks away leaves no row behind.
 */

export interface TrackPreview {
  kind: "track";
  provider: Provider;
  providerId: string;
  title: string;
  artistDisplay: string;
  albumTitle: string | null;
  artwork: Artwork;
  /** Set when we already hold this recording, so the UI can say so. */
  knownRecordingId: string | null;
  /** True when the metadata came from PostgreSQL rather than a provider. */
  fromDatabase: boolean;
}

export interface CollectionPreview {
  kind: "collection";
  collectionKind: "album" | "playlist";
  provider: Provider;
  providerId: string;
  name: string;
  /** Album artists, or a playlist's curator. */
  byline: string | null;
  artwork: Artwork;
  trackCount: number;
  truncated: boolean;
}

export type LinkPreview =
  | TrackPreview
  | CollectionPreview
  | { kind: "unsupported"; message: string }
  | { kind: "unavailable"; message: string };

const NOT_A_LINK =
  "That doesn't look like a music link we can read. Check it, or switch to entering the details yourself.";

export async function previewLink(input: string): Promise<LinkPreview> {
  const apple = parseAppleMusicLink(input);
  if (apple.kind !== "unsupported") return previewApple(apple);
  const tidal = parseTidalLink(input);
  if (tidal.kind !== "unsupported") return previewTidal(tidal);
  return previewSpotify(input);
}

// --- Tidal -------------------------------------------------------------------

async function previewTidal(ref: TidalRef): Promise<LinkPreview> {
  if (ref.kind === "artist") {
    return {
      kind: "unsupported",
      message: "That's an artist page. Paste a track, album or playlist instead.",
    };
  }
  if (ref.kind === "short-link") {
    return {
      kind: "unsupported",
      message: "Open that tidal.link in Tidal and copy the full link — we don't follow short links.",
    };
  }
  if (ref.kind === "unsupported") return { kind: "unsupported", message: NOT_A_LINK };

  if (ref.kind === "track") {
    const known = await knownRecording(Provider.tidal, ref.id);
    if (known) return known;
  }
  if (!tidalConfigured()) {
    return {
      kind: "unavailable",
      message:
        ref.kind === "track"
          ? "Tidal links can't be read here yet. You can enter the details yourself instead."
          : "Tidal collections can't be read here yet. A CSV export still works.",
    };
  }

  try {
    if (ref.kind === "track") {
      const track = await fetchTidalTrack(ref.id);
      if (!track) return { kind: "unavailable", message: "Tidal doesn't have that track available." };
      return {
        kind: "track",
        provider: Provider.tidal,
        providerId: track.providerId,
        title: track.name,
        artistDisplay: track.artistDisplay,
        albumTitle: track.album?.name ?? null,
        artwork: track.artwork ?? NO_ARTWORK,
        knownRecordingId: null,
        fromDatabase: false,
      };
    }

    const data = ref.kind === "album" ? await fetchTidalAlbum(ref.id) : await fetchTidalPlaylist(ref.id);
    if (!data) {
      return {
        kind: "unavailable",
        message:
          ref.kind === "playlist"
            ? "Tidal won't share that playlist — it may be private, or not available in this region. A CSV export still works."
            : "Tidal doesn't have that album available in this region.",
      };
    }
    return {
      kind: "collection",
      collectionKind: data.kind,
      provider: Provider.tidal,
      providerId: data.providerId,
      name: data.name,
      byline: ref.kind === "album" ? data.tracks[0]?.album?.artists.map((a) => a.name).join(", ") || null : null,
      artwork: data.artwork ?? NO_ARTWORK,
      trackCount: data.tracks.length,
      truncated: data.truncated,
    };
  } catch (error) {
    if (!(error instanceof TidalUnavailableError)) throw error;
    return {
      kind: "unavailable",
      message:
        error.reason === "rate-limited"
          ? "Tidal is busy right now. Try again in a minute."
          : "We couldn't reach Tidal just now.",
    };
  }
}

// --- Spotify -----------------------------------------------------------------

async function previewSpotify(input: string): Promise<LinkPreview> {
  let ref = parseSpotifyLink(input);

  if (ref.kind === "short-link") {
    const resolved = await resolveSpotifyShortLink(input);
    if (!resolved.ok) {
      return {
        kind: "unsupported",
        message: "We couldn't follow that short link. Open it in Spotify and copy the full link.",
      };
    }
    ref = resolved.ref;
  }

  if (ref.kind === "artist") {
    return {
      kind: "unsupported",
      message: "That's an artist page. Paste a track, album or playlist instead.",
    };
  }
  if (ref.kind === "unsupported" || ref.kind === "short-link") {
    return { kind: "unsupported", message: NOT_A_LINK };
  }

  if (ref.kind === "track") {
    // DATABASE FIRST — the same guarantee capture makes. A track we hold costs
    // no provider call however many times it is pasted.
    const known = await knownRecording(Provider.spotify, ref.id);
    if (known) return known;

    if (!spotifyConfigured()) {
      return {
        kind: "unavailable",
        message: "We can't look that up right now. You can enter the details yourself instead.",
      };
    }
    const track = await fetchTrack(ref.id);
    if (!track) {
      return {
        kind: "unavailable",
        message: "Spotify doesn't have that track available.",
      };
    }
    return {
      kind: "track",
      provider: Provider.spotify,
      providerId: track.id,
      title: track.name,
      artistDisplay: track.artistDisplay,
      albumTitle: track.album?.name ?? null,
      artwork: track.album?.artwork ?? NO_ARTWORK,
      knownRecordingId: null,
      fromDatabase: false,
    };
  }

  if (!spotifyConfigured()) {
    return {
      kind: "unavailable",
      message: `We can't read that ${ref.kind} right now. A CSV export still works.`,
    };
  }

  const data =
    ref.kind === "album" ? await fetchAlbum(ref.id) : await fetchPlaylist(ref.id);

  if (!data) {
    return {
      kind: "unavailable",
      message:
        ref.kind === "playlist"
          ? "Spotify won't share that playlist — it's either one of Spotify's own editorial playlists or a private one. A CSV export still works."
          : "Spotify doesn't have that album available.",
    };
  }

  return {
    kind: "collection",
    collectionKind: data.kind,
    provider: Provider.spotify,
    providerId: data.id,
    name: data.name,
    byline: data.artists.map((a) => a.name).join(", ") || data.ownerName,
    artwork: data.artwork ?? NO_ARTWORK,
    trackCount: data.tracks.length,
    truncated: data.truncated,
  };
}

// --- Apple Music -------------------------------------------------------------

async function previewApple(ref: ReturnType<typeof parseAppleMusicLink>): Promise<LinkPreview> {
  if (ref.kind === "artist") {
    return {
      kind: "unsupported",
      message: "That's an artist page. Paste a track, album or playlist instead.",
    };
  }

  try {
    if (ref.kind === "track") {
      const known = await knownRecording(Provider.apple_music, ref.id);
      if (known) return known;

      const track = await fetchAppleTrack(ref.id);
      if (!track) {
        return { kind: "unavailable", message: "Apple Music doesn't have that track available." };
      }
      return {
        kind: "track",
        provider: Provider.apple_music,
        providerId: track.id,
        title: track.name,
        artistDisplay: track.artistName,
        albumTitle: track.albumName,
        artwork: track.artwork ?? NO_ARTWORK,
        knownRecordingId: null,
        fromDatabase: false,
      };
    }

    if (ref.kind === "playlist") {
      if (!appleMusicConfigured()) {
        return {
          kind: "unavailable",
          message: "Apple Music playlists need a developer key that isn't set up. A CSV export still works.",
        };
      }
      const data = await fetchApplePlaylistCatalog(ref.id);
      return collectionFromImportable(data, "playlist");
    }

    if (ref.kind !== "album") return { kind: "unsupported", message: NOT_A_LINK };

    // Album: the catalog API when a token exists, the public lookup otherwise.
    if (appleMusicConfigured()) {
      const data = await fetchAppleAlbumCatalog(ref.id);
      return collectionFromImportable(data, "album");
    }
    const album = await fetchAppleAlbum(ref.id);
    if (!album) {
      return { kind: "unavailable", message: "Apple Music doesn't have that album available." };
    }
    return {
      kind: "collection",
      collectionKind: "album",
      provider: Provider.apple_music,
      providerId: album.id,
      name: album.name,
      byline: album.artistName,
      artwork: album.artwork ?? NO_ARTWORK,
      trackCount: album.tracks.length,
      truncated: false,
    };
  } catch (error) {
    if (!(error instanceof AppleMusicUnavailableError)) throw error;
    return {
      kind: "unavailable",
      message:
        error.reason === "not-found"
          ? "Apple Music doesn't have that available."
          : "We couldn't reach Apple Music just now.",
    };
  }
}

function collectionFromImportable(
  data: { providerId: string; name: string; tracks: unknown[]; truncated: boolean; artwork?: Artwork },
  kind: "album" | "playlist",
): CollectionPreview {
  return {
    kind: "collection",
    collectionKind: kind,
    provider: Provider.apple_music,
    providerId: data.providerId,
    name: data.name,
    byline: null,
    artwork: data.artwork ?? NO_ARTWORK,
    trackCount: data.tracks.length,
    truncated: data.truncated,
  };
}

// --- shared ------------------------------------------------------------------

/** A recording we already hold, answered without touching the network. */
async function knownRecording(
  provider: Provider,
  providerId: string,
): Promise<TrackPreview | null> {
  const mapping = await prisma.recordingExternalId.findUnique({
    where: { provider_providerId: { provider, providerId } },
    include: { recording: { include: { album: true } } },
  });
  if (!mapping) return null;

  const r = mapping.recording;
  return {
    kind: "track",
    provider,
    providerId,
    title: r.title,
    artistDisplay: r.artistDisplay,
    albumTitle: r.album?.title ?? r.releaseTitle ?? null,
    artwork: {
      url: r.artworkUrl ?? r.album?.artworkUrl ?? null,
      thumbUrl: r.artworkThumbUrl ?? r.album?.artworkThumbUrl ?? null,
    },
    knownRecordingId: r.id,
    fromDatabase: true,
  };
}
