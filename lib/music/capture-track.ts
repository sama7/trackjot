import { Provider } from "@prisma/client";
import { prisma } from "@/lib/db";
import { findByProviderId, resolveByProviderId } from "@/lib/music/resolve-recording";
import { resolveImportableTrack } from "@/lib/music/persist-track";
import type { ImportableTrack } from "@/lib/music/importable";
import { parseSpotifyLink, type SpotifyRef } from "@/lib/music/spotify/parse-link";
import { resolveSpotifyShortLink } from "@/lib/music/spotify/resolve-short-link";
import { fetchSpotifyOEmbed } from "@/lib/music/spotify/oembed";
import { fetchTrack, spotifyConfigured } from "@/lib/music/spotify/web-api";
import { parseAppleMusicLink } from "@/lib/music/apple/parse-link";
import { fetchAppleTrack } from "@/lib/music/apple/itunes";
import { AppleMusicUnavailableError } from "@/lib/music/apple/music-api";
import type { Recording } from "@prisma/client";
import { parseTidalLink, type TidalRef } from "@/lib/music/tidal/parse-link";
import { fetchTidalTrack, tidalConfigured, TidalUnavailableError } from "@/lib/music/tidal/api";

/**
 * Capturing a single pasted track link, from either provider.
 *
 * ## Why this replaces the oEmbed-only path
 *
 * Capture used to ask Spotify's oEmbed endpoint, which returns a title and — as
 * verified against the live endpoint — **no artist field of any kind**. So every
 * first paste of a new track stopped to ask the user to type the artist, and the
 * row it eventually wrote had a display string and no linked entities: no
 * artists, no album, no ISRC.
 *
 * Meanwhile `fetchTrack` had been written, tested, and never called. Spotify's
 * Client Credentials flow authenticates the *application*, so it costs nothing
 * against the five-user cap, and `/v1/tracks/{id}` returns the artists with
 * their IDs, the album with its ID, the duration and the ISRC. Pasting a track
 * link now produces exactly the same row as importing the album that contains
 * it, because both go through `resolveImportableTrack`.
 *
 * oEmbed remains as the degraded path when no credential is configured. That is
 * the core independence invariant (AGENTS.md §1) and it still holds: with every
 * Spotify variable absent, a note can still be written — the user just supplies
 * the artist.
 *
 * ## The ordering is load bearing
 *
 * The database is consulted first, always. A track anyone has captured before
 * resolves with **zero** network calls, so provider requests scale with how fast
 * the catalog grows rather than with how much the product is used. Reversing
 * these two lines would quietly turn a shared quota into a per-request cost, so
 * `no-network-on-known-track.test.ts` counts the calls directly.
 */

export type CaptureOutcome =
  | {
      ok: true;
      recording: Recording;
      /** Where the metadata came from. "database" means no provider was contacted. */
      source: "database" | "provider" | "oembed" | "manual";
      /** True when entities (artists, album, ISRC) were linked, not just strings. */
      linked: boolean;
    }
  | {
      ok: false;
      reason: CaptureRefusal;
      message: string;
      /** What we did learn, so the form prefills rather than making them retype. */
      suggested?: { title?: string | null };
    };

export type CaptureRefusal =
  | "collection"
  | "artist"
  | "short-link"
  | "unsupported"
  | "provider-unavailable"
  | "needs-manual-metadata";

export interface CaptureOptions {
  /** Supplied by the user when metadata is unavailable. Never authoritative
   *  over an existing shared recording. */
  fallback?: { title: string; artistDisplay: string };
  fetchOEmbed?: typeof fetchSpotifyOEmbed;
  resolveShortLink?: typeof resolveSpotifyShortLink;
  fetchTrackImpl?: typeof fetchTrack;
  fetchAppleTrackImpl?: typeof fetchAppleTrack;
  fetchTidalTrackImpl?: typeof fetchTidalTrack;
}

const COLLECTION_HINT =
  "That's an album or playlist — paste it on its own and we'll import the whole thing as a collection.";

/** Provider-neutral entry point: works out who the link belongs to. */
export async function captureFromLink(
  input: string,
  options: CaptureOptions = {},
): Promise<CaptureOutcome> {
  const apple = parseAppleMusicLink(input);
  if (apple.kind !== "unsupported") return captureAppleTrack(apple, options);
  const tidal = parseTidalLink(input);
  if (tidal.kind !== "unsupported") return captureTidalTrack(tidal, options);
  return captureSpotifyTrack(input, options);
}

async function captureSpotifyTrack(
  input: string,
  options: CaptureOptions,
): Promise<CaptureOutcome> {
  let ref: SpotifyRef = parseSpotifyLink(input);

  if (ref.kind === "short-link") {
    const resolved = await (options.resolveShortLink ?? resolveSpotifyShortLink)(input);
    if (!resolved.ok) {
      return {
        ok: false,
        reason: "short-link",
        message:
          "We couldn't follow that short Spotify link. Open it in Spotify and copy the full track link.",
      };
    }
    ref = resolved.ref;
  }

  switch (ref.kind) {
    case "album":
    case "playlist":
      return { ok: false, reason: "collection", message: COLLECTION_HINT };
    case "artist":
      return {
        ok: false,
        reason: "artist",
        message: "TrackJot captures tracks, albums and playlists — not artist pages yet.",
      };
    case "short-link":
      return { ok: false, reason: "short-link", message: "We couldn't follow that short link." };
    case "unsupported":
      return {
        ok: false,
        reason: "unsupported",
        message: "That doesn't look like a Spotify or Apple Music link.",
      };
    case "track":
      break;
  }

  return captureSpotifyTrackById(ref.id, ref.canonicalUrl, options);
}

/**
 * Capture by identifier rather than by link.
 *
 * The two-step capture form resolves a link to a provider ID first (see
 * `previewLink`) and only writes when the user confirms, so by the time it saves
 * it has an ID and no longer has a parsed ref. Routing that through here rather
 * than through a second copy of the mapping keeps one definition of what a
 * provider-anchored recording looks like — the same reason `resolveImportableTrack`
 * was extracted in the first place.
 */
export async function captureFromProviderRef(
  provider: Provider,
  providerId: string,
  options: CaptureOptions = {},
): Promise<CaptureOutcome> {
  switch (provider) {
    case Provider.apple_music:
      return captureAppleTrackById(providerId, options);
    case Provider.tidal:
      return captureTidalTrackById(providerId, options);
    default:
      return captureSpotifyTrackById(providerId, undefined, options);
  }
}

async function captureSpotifyTrackById(
  id: string,
  canonicalUrl: string | undefined,
  options: CaptureOptions,
): Promise<CaptureOutcome> {
  // DATABASE FIRST — see the header. Do not move this below a network call.
  const known = await findByProviderId(Provider.spotify, id);
  if (known) return { ok: true, recording: known, source: "database", linked: true };

  /**
   * The credential gate guards the DEFAULT implementation, not an injected one.
   *
   * Gating on `spotifyConfigured()` alone meant an injected `fetchTrackImpl` was
   * silently ignored when no credential happened to be present — so tests
   * exercised the Web API path on a developer laptop and the oEmbed path in CI,
   * which is the precise failure mode of a test that proves nothing. An injected
   * implementation is by definition not a call to the real API, so there is
   * nothing for the gate to protect.
   */
  if (options.fetchTrackImpl || spotifyConfigured()) {
    try {
      // Returns null rather than throwing on an unavailable track or a failed
      // request, so a null here is a reason to degrade, not to fail.
      const track = await (options.fetchTrackImpl ?? fetchTrack)(id);
      if (!track) return degradedSpotifyCapture(id, canonicalUrl, options);

      const recording = await persist(Provider.spotify, {
        providerId: track.id,
        name: track.name,
        artistDisplay: track.artistDisplay,
        artists: track.artists.map((a) => ({ providerId: a.id, name: a.name })),
        durationMs: track.durationMs,
        isrc: track.isrc,
        trackNumber: track.trackNumber,
        artwork: track.album?.artwork,
        album: track.album
          ? {
              providerId: track.album.id,
              name: track.album.name,
              artists: track.album.artists.map((a) => ({ providerId: a.id, name: a.name })),
              releaseDate: track.album.releaseDate,
              artwork: track.album.artwork,
            }
          : null,
      });
      return { ok: true, recording, source: "provider", linked: true };
    } catch {
      /**
       * `fetchTrack` swallows provider failures and returns null, so anything
       * thrown here came from persisting — and the degraded path would only
       * fail the same way. Falling through keeps a transient database hiccup
       * from being reported as "we couldn't reach Spotify", which would send
       * the user chasing the wrong problem.
       */
    }
  }

  return degradedSpotifyCapture(id, canonicalUrl, options);
}

/**
 * The no-credential path, unchanged in spirit from the original implementation.
 *
 * oEmbed gives a title and never an artist, so this asks for one. It is a
 * prompt, not a failure — and the title comes back so the user fills one field
 * rather than two. We never invent an artist: canonical metadata is write-once,
 * so a guess here would become everyone's guess.
 */
async function degradedSpotifyCapture(
  id: string,
  canonicalUrl: string | undefined,
  options: CaptureOptions,
): Promise<CaptureOutcome> {
  const oembed = await (options.fetchOEmbed ?? fetchSpotifyOEmbed)("track", id);

  const title = options.fallback?.title?.trim() || oembed?.title?.trim() || "";
  const artistDisplay = options.fallback?.artistDisplay?.trim() || "";

  if (!title || !artistDisplay) {
    return {
      ok: false,
      reason: "needs-manual-metadata",
      message: title
        ? `Found “${title}”. Spotify's public preview doesn't include the artist — add it and we'll save this.`
        : "We couldn't fetch this track's details. Add the title and artist and we'll save it.",
      suggested: { title: title || null },
    };
  }

  const result = await resolveByProviderId({
    provider: Provider.spotify,
    providerId: id,
    providerUrl: canonicalUrl,
    title,
    artistDisplay,
  });
  return {
    ok: true,
    recording: result.recording,
    source: oembed ? "oembed" : "manual",
    linked: false,
  };
}

async function captureAppleTrack(
  ref: ReturnType<typeof parseAppleMusicLink>,
  options: CaptureOptions,
): Promise<CaptureOutcome> {
  if (ref.kind === "album" || ref.kind === "playlist") {
    return { ok: false, reason: "collection", message: COLLECTION_HINT };
  }
  if (ref.kind === "artist") {
    return {
      ok: false,
      reason: "artist",
      message: "TrackJot captures tracks, albums and playlists — not artist pages yet.",
    };
  }
  if (ref.kind !== "track") {
    return {
      ok: false,
      reason: "unsupported",
      message: "That doesn't look like an Apple Music track link.",
    };
  }

  return captureAppleTrackById(ref.id, options);
}

async function captureAppleTrackById(
  id: string,
  options: CaptureOptions,
): Promise<CaptureOutcome> {
  const known = await findByProviderId(Provider.apple_music, id);
  if (known) return { ok: true, recording: known, source: "database", linked: true };

  try {
    /**
     * The public iTunes lookup, deliberately: it needs no developer token, so
     * Apple track capture works on a free account. It flattens a collaboration
     * into one credit string plus one artist id, which is why `artists` may hold
     * a single entry where Spotify would hold two. That is a real difference in
     * what Apple hands us, not something to paper over by splitting the string.
     */
    const track = await (options.fetchAppleTrackImpl ?? fetchAppleTrack)(id);
    if (!track) {
      return {
        ok: false,
        reason: "provider-unavailable",
        message: "Apple Music doesn't have that track available.",
      };
    }
    const recording = await persist(Provider.apple_music, {
      providerId: track.id,
      name: track.name,
      artistDisplay: track.artistName,
      artists: track.artistId ? [{ providerId: track.artistId, name: track.artistName }] : [],
      durationMs: track.durationMs,
      isrc: null,
      trackNumber: track.trackNumber,
      artwork: track.artwork,
      album:
        track.albumId && track.albumName
          ? {
              providerId: track.albumId,
              name: track.albumName,
              artists: track.artistId
                ? [{ providerId: track.artistId, name: track.artistName }]
                : [],
              releaseDate: track.releaseDate,
              artwork: track.artwork,
            }
          : null,
    });
    return { ok: true, recording, source: "provider", linked: true };
  } catch (error) {
    if (!(error instanceof AppleMusicUnavailableError)) throw error;
    return {
      ok: false,
      reason: "provider-unavailable",
      message:
        error.reason === "not-found"
          ? "Apple Music doesn't have that track available."
          : "We couldn't reach Apple Music just now. Try again in a moment.",
    };
  }
}

async function captureTidalTrack(ref: TidalRef, options: CaptureOptions): Promise<CaptureOutcome> {
  switch (ref.kind) {
    case "album":
    case "playlist":
      return { ok: false, reason: "collection", message: COLLECTION_HINT };
    case "artist":
      return {
        ok: false,
        reason: "artist",
        message: "TrackJot captures tracks, albums and playlists — not artist pages yet.",
      };
    case "short-link":
      return {
        ok: false,
        reason: "short-link",
        message: "Open that tidal.link in Tidal and copy the full track link instead.",
      };
    case "unsupported":
      return { ok: false, reason: "unsupported", message: "That doesn't look like a Tidal track link." };
    case "track":
      return captureTidalTrackById(ref.id, options);
  }
}

async function captureTidalTrackById(id: string, options: CaptureOptions): Promise<CaptureOutcome> {
  // DATABASE FIRST, as for every provider.
  const known = await findByProviderId(Provider.tidal, id);
  if (known) return { ok: true, recording: known, source: "database", linked: true };

  if (!options.fetchTidalTrackImpl && !tidalConfigured()) {
    return {
      ok: false,
      reason: "provider-unavailable",
      message: "Tidal links can't be read here yet. You can enter the details yourself instead.",
    };
  }
  try {
    const track = await (options.fetchTidalTrackImpl ?? fetchTidalTrack)(id);
    if (!track) {
      return { ok: false, reason: "provider-unavailable", message: "Tidal doesn't have that track available." };
    }
    const recording = await persist(Provider.tidal, track);
    return { ok: true, recording, source: "provider", linked: true };
  } catch (error) {
    if (!(error instanceof TidalUnavailableError)) throw error;
    return {
      ok: false,
      reason: "provider-unavailable",
      message:
        error.reason === "rate-limited"
          ? "Tidal is busy right now. Try again in a minute."
          : "We couldn't reach Tidal just now. Try again in a moment.",
    };
  }
}

async function persist(provider: Provider, track: ImportableTrack): Promise<Recording> {
  const { recordingId } = await resolveImportableTrack(prisma, provider, track);
  return prisma.recording.findUniqueOrThrow({ where: { id: recordingId } });
}
