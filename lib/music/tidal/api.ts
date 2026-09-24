import { z } from "zod";
import { NO_ARTWORK, type Artwork } from "../artwork";
import type { ImportableArtist, ImportableCollection, ImportableTrack } from "../importable";
import { tidalUrlFor } from "./parse-link";

/**
 * Tidal's catalogue API (openapi.tidal.com/v2) via the client-credentials flow.
 *
 * Like Spotify's Client Credentials, this authenticates the *application*: no
 * Tidal user signs in, nothing is stored per user, and there is no cap on how
 * many TrackJot users can paste a Tidal link. Tracks, albums and playlists are
 * all readable with it (the spec marks each `Client_Credentials` +
 * `THIRD_PARTY`); a private playlist behaves as if it does not exist.
 *
 * Optional. With `TIDAL_CLIENT_ID`/`TIDAL_CLIENT_SECRET` unset every entry
 * point reports "not configured" and the UI never offers Tidal as working.
 *
 * ## Shape
 *
 * JSON:API. A request names the relationships it wants with `include`, nested
 * with dots, and the related resources arrive flattened in `included`. So a
 * page of playlist items asks for `items.artists,items.albums.coverArt` and
 * gets the tracks, their artists, their albums and the album art in one round
 * trip; this module re-assembles them by `type:id`.
 *
 * ## What is kept
 *
 * Only what `ImportableTrack` carries — ids, names, ISRC, duration, release
 * date and artwork links. The ISRC is the important one: Tidal's API offers no
 * public preview, and the ISRC is what lets the preview player find the same
 * recording on Deezer.
 */

const TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";
const API = "https://openapi.tidal.com/v2";
const TIMEOUT_MS = 8_000;
/** Refuse to walk a pathological playlist forever. */
const MAX_PAGES = 40;
/** `filter[id]` accepts at most 20 ids per request. */
const BATCH = 20;
/** How many times one import will wait out a 429, and the longest single wait. */
const MAX_RATE_LIMIT_WAITS = 8;
const MAX_RATE_LIMIT_DELAY_MS = 15_000;

/** Replaceable in tests, so honouring Retry-After does not make them slow. */
let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export function setTidalSleepForTests(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
}

export class TidalUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: "not-configured" | "not-found" | "rate-limited" | "unavailable",
  ) {
    super(message);
    this.name = "TidalUnavailableError";
  }
}

export function tidalConfigured(): boolean {
  return Boolean(process.env.TIDAL_CLIENT_ID && process.env.TIDAL_CLIENT_SECRET);
}

/** Tidal's catalogue is regional; this is the storefront we read. */
function countryCode(): string {
  const configured = process.env.TIDAL_COUNTRY_CODE?.trim().toUpperCase();
  return configured && /^[A-Z]{2}$/.test(configured) ? configured : "US";
}

// --- wire schemas -------------------------------------------------------------
// Permissive by design: unknown members are ignored, and only what is used is
// required. Tidal documents that enums and members grow without notice.

const Identifier = z.object({ id: z.string(), type: z.string() }).passthrough();
const Relationship = z.object({ data: z.union([z.array(Identifier), Identifier, z.null()]).optional() });

const Resource = z
  .object({
    id: z.string(),
    type: z.string(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    relationships: z.record(z.string(), Relationship).optional(),
  })
  .passthrough();
type Resource = z.infer<typeof Resource>;

const SingleDocument = z.object({
  data: Resource,
  included: z.array(Resource).optional(),
});
const ManyDocument = z.object({
  data: z.array(Resource),
  included: z.array(Resource).optional(),
});
const RelationshipDocument = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      meta: z.object({ trackNumber: z.number().optional() }).passthrough().optional(),
    }),
  ),
  included: z.array(Resource).optional(),
  links: z.object({ next: z.string().optional() }).passthrough().optional(),
});

const TrackAttributes = z.object({
  title: z.string(),
  version: z.string().nullish(),
  isrc: z.string().nullish(),
  duration: z.string().nullish(),
});
const AlbumAttributes = z.object({
  title: z.string(),
  releaseDate: z.string().nullish(),
  numberOfItems: z.number().nullish(),
});
const PlaylistAttributes = z.object({
  name: z.string(),
  description: z.string().nullish(),
  numberOfItems: z.number().nullish(),
  numberOfTrackItems: z.number().nullish(),
});
const ArtistAttributes = z.object({ name: z.string() });
const ArtworkAttributes = z.object({
  files: z
    .array(
      z.object({
        href: z.string(),
        meta: z.object({ width: z.number(), height: z.number() }).partial().optional(),
      }),
    )
    .default([]),
});

// --- transport ----------------------------------------------------------------

let cachedToken: { value: string; expiresAt: number } | null = null;

/** For tests: forget the cached application token. */
export function resetTidalToken(): void {
  cachedToken = null;
}

async function appToken(fetchImpl: typeof fetch): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;

  const id = process.env.TIDAL_CLIENT_ID;
  const secret = process.env.TIDAL_CLIENT_SECRET;
  if (!id || !secret) throw new TidalUnavailableError("Tidal is not configured.", "not-configured");

  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new TidalUnavailableError("Could not obtain a Tidal token.", "unavailable");

  const body = z
    .object({ access_token: z.string(), expires_in: z.number().optional() })
    .safeParse(await response.json());
  if (!body.success) throw new TidalUnavailableError("Tidal returned no token.", "unavailable");

  cachedToken = {
    value: body.data.access_token,
    expiresAt: Date.now() + (body.data.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

/**
 * GET a path under the API root. `path` may carry a query string — Tidal's
 * `links.next` is a root-relative path with its cursor already in it — and the
 * country code is added when absent.
 */
async function get(
  path: string,
  fetchImpl: typeof fetch,
  retried = false,
  waits = 0,
): Promise<unknown> {
  // `links.next` is documented as root-relative ("/albums/…?page[cursor]=…");
  // tolerate it arriving with the version prefix or as an absolute URL too.
  const relative = path.replace(/^https:\/\/openapi\.tidal\.com/, "").replace(/^\/v2(?=\/)/, "");
  const url = new URL(`${API}${relative.startsWith("/") ? relative : `/${relative}`}`);
  // Never follow a `next` link off Tidal's API host.
  if (url.origin !== new URL(API).origin) {
    throw new TidalUnavailableError("Unexpected Tidal link.", "unavailable");
  }
  if (!url.searchParams.has("countryCode")) url.searchParams.set("countryCode", countryCode());

  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.api+json",
      authorization: `Bearer ${await appToken(fetchImpl)}`,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (response.status === 401 && !retried) {
    cachedToken = null;
    return get(path, fetchImpl, true, waits);
  }
  /**
   * Tidal pages playlist items about twenty at a time and offers no larger
   * page, so walking a big playlist is many requests in a row — and the fifth
   * one in quick succession was answered `429` with `Retry-After: 4`, measured
   * against the live API on 2026-09-23. That is an instruction, not a failure:
   * wait as told and carry on. Bounded, so a sustained limit still surfaces as
   * "rate-limited" rather than hanging an import.
   */
  if (response.status === 429 && waits < MAX_RATE_LIMIT_WAITS) {
    const seconds = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2_000;
    if (delay <= MAX_RATE_LIMIT_DELAY_MS) {
      await sleep(delay);
      return get(path, fetchImpl, retried, waits + 1);
    }
  }
  if (response.status === 404) throw new TidalUnavailableError("Not found on Tidal.", "not-found");
  if (response.status === 429) throw new TidalUnavailableError("Tidal rate limit.", "rate-limited");
  if (!response.ok) throw new TidalUnavailableError(`Tidal answered ${response.status}.`, "unavailable");
  return response.json();
}

// --- assembly -----------------------------------------------------------------

type Index = Map<string, Resource>;

function indexOf(...groups: (Resource[] | undefined)[]): Index {
  const index: Index = new Map();
  for (const group of groups) for (const r of group ?? []) index.set(`${r.type}:${r.id}`, r);
  return index;
}

function related(resource: Resource, name: string): { id: string; type: string }[] {
  const data = resource.relationships?.[name]?.data;
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
}

/** ISO 8601 duration, e.g. `PT3M25S` or `PT1H2M3.5S`, to milliseconds. */
export function durationToMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!match) return null;
  const [, h = "0", m = "0", s = "0"] = match;
  return Math.round((Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000);
}

/** The largest rendition for display, a small one for lists. */
function artworkFrom(resource: Resource | undefined): Artwork {
  if (!resource) return NO_ARTWORK;
  const parsed = ArtworkAttributes.safeParse(resource.attributes ?? {});
  if (!parsed.success) return NO_ARTWORK;
  const files = parsed.data.files
    .filter((f) => f.href.startsWith("https://"))
    .map((f) => ({ href: f.href, width: f.meta?.width ?? 0 }))
    .sort((a, b) => a.width - b.width);
  if (files.length === 0) return NO_ARTWORK;
  const full = files.filter((f) => f.width <= 1280).at(-1) ?? files.at(-1)!;
  const thumb = files.find((f) => f.width >= 160) ?? full;
  return { url: full.href, thumbUrl: thumb.href };
}

function artistsOf(resource: Resource, index: Index): ImportableArtist[] {
  return related(resource, "artists").flatMap((ref) => {
    const artist = index.get(`artists:${ref.id}`);
    const attributes = ArtistAttributes.safeParse(artist?.attributes ?? {});
    return attributes.success ? [{ providerId: ref.id, name: attributes.data.name }] : [];
  });
}

function albumOf(resource: Resource, index: Index): ImportableTrack["album"] {
  const ref = related(resource, "albums")[0];
  if (!ref) return null;
  const album = index.get(`albums:${ref.id}`);
  const attributes = AlbumAttributes.safeParse(album?.attributes ?? {});
  if (!album || !attributes.success) return null;
  const coverRef = related(album, "coverArt")[0];
  return {
    providerId: album.id,
    name: attributes.data.title,
    artists: artistsOf(album, index),
    releaseDate: attributes.data.releaseDate ?? null,
    artwork: artworkFrom(coverRef ? index.get(`artworks:${coverRef.id}`) : undefined),
  };
}

/** A track resource and its included neighbours as an ImportableTrack. */
function toTrack(resource: Resource, index: Index, trackNumber: number | null = null): ImportableTrack | null {
  const attributes = TrackAttributes.safeParse(resource.attributes ?? {});
  if (!attributes.success) return null;
  const { title, version, isrc, duration } = attributes.data;
  const artists = artistsOf(resource, index);
  const album = albumOf(resource, index);
  return {
    providerId: resource.id,
    // Tidal keeps "Remastered 2011" apart from the title; everyone else shows it.
    name: version ? `${title} (${version})` : title,
    artistDisplay: artists.map((a) => a.name).join(", ") || "Unknown artist",
    artists,
    durationMs: durationToMs(duration),
    isrc: isrc ?? null,
    trackNumber,
    artwork: album?.artwork,
    album,
  };
}

const TRACK_INCLUDE = "artists,albums.artists,albums.coverArt";

// --- public entry points --------------------------------------------------------

export async function fetchTidalTrack(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ImportableTrack | null> {
  try {
    const doc = SingleDocument.parse(
      await get(`/tracks/${encodeURIComponent(id)}?include=${TRACK_INCLUDE}`, fetchImpl),
    );
    return toTrack(doc.data, indexOf(doc.included));
  } catch (error) {
    if (error instanceof TidalUnavailableError && error.reason === "not-found") return null;
    throw error;
  }
}

/**
 * Walk an album's or playlist's `items` relationship in order, keeping
 * duplicates and skipping videos, and return the tracks fully assembled.
 *
 * Nested includes normally deliver every track's artists and album with the
 * page. Any track that arrives without them is fetched again in batches of 20
 * through `/tracks?filter[id]=…`, so an include Tidal declines to expand costs
 * extra requests rather than silently producing tracks with no artist.
 */
async function walkItems(
  path: string,
  fetchImpl: typeof fetch,
): Promise<{ tracks: ImportableTrack[]; truncated: boolean }> {
  const order: { id: string; trackNumber: number | null }[] = [];
  const pool: Resource[] = [];
  let next: string | undefined = `${path}?include=items.artists,items.albums.artists,items.albums.coverArt`;
  let pages = 0;

  while (next && pages < MAX_PAGES) {
    const page = RelationshipDocument.parse(await get(next, fetchImpl));
    for (const item of page.data) {
      if (item.type === "tracks") order.push({ id: item.id, trackNumber: item.meta?.trackNumber ?? null });
    }
    pool.push(...(page.included ?? []));
    next = page.links?.next;
    pages++;
  }
  const truncated = Boolean(next);

  let index = indexOf(pool);
  const incomplete = [...new Set(order.map((o) => o.id))].filter((id) => {
    const track = index.get(`tracks:${id}`);
    return !track || !track.relationships?.artists;
  });
  for (let i = 0; i < incomplete.length; i += BATCH) {
    const ids = incomplete.slice(i, i + BATCH);
    const query = ids.map((id) => `filter[id]=${encodeURIComponent(id)}`).join("&");
    const doc = ManyDocument.parse(await get(`/tracks?${query}&include=${TRACK_INCLUDE}`, fetchImpl));
    pool.push(...doc.data, ...(doc.included ?? []));
  }
  if (incomplete.length > 0) index = indexOf(pool);

  const tracks = order.flatMap(({ id, trackNumber }) => {
    const resource = index.get(`tracks:${id}`);
    const track = resource ? toTrack(resource, index, trackNumber) : null;
    return track ? [track] : [];
  });
  return { tracks, truncated };
}

export async function fetchTidalAlbum(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ImportableCollection | null> {
  try {
    const doc = SingleDocument.parse(
      await get(`/albums/${encodeURIComponent(id)}?include=artists,coverArt`, fetchImpl),
    );
    const attributes = AlbumAttributes.parse(doc.data.attributes ?? {});
    const index = indexOf(doc.included);
    const coverRef = related(doc.data, "coverArt")[0];
    const artwork = artworkFrom(coverRef ? index.get(`artworks:${coverRef.id}`) : undefined);
    const { tracks, truncated } = await walkItems(
      `/albums/${encodeURIComponent(id)}/relationships/items`,
      fetchImpl,
    );
    return {
      provider: "tidal",
      providerId: doc.data.id,
      kind: "album",
      name: attributes.title,
      description: null,
      sourceUrl: tidalUrlFor("album", doc.data.id),
      artwork,
      truncated,
      tracks,
    };
  } catch (error) {
    if (error instanceof TidalUnavailableError && error.reason === "not-found") return null;
    throw error;
  }
}

export async function fetchTidalPlaylist(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ImportableCollection | null> {
  try {
    const doc = SingleDocument.parse(
      await get(`/playlists/${encodeURIComponent(id)}?include=coverArt`, fetchImpl),
    );
    const attributes = PlaylistAttributes.parse(doc.data.attributes ?? {});
    const index = indexOf(doc.included);
    const coverRef = related(doc.data, "coverArt")[0];
    const { tracks, truncated } = await walkItems(
      `/playlists/${encodeURIComponent(id)}/relationships/items`,
      fetchImpl,
    );
    return {
      provider: "tidal",
      providerId: doc.data.id,
      kind: "playlist",
      name: attributes.name,
      description: attributes.description ?? null,
      sourceUrl: tidalUrlFor("playlist", doc.data.id),
      artwork: artworkFrom(coverRef ? index.get(`artworks:${coverRef.id}`) : undefined),
      truncated,
      tracks,
    };
  } catch (error) {
    if (error instanceof TidalUnavailableError && error.reason === "not-found") return null;
    throw error;
  }
}

export interface TidalCollectionSummary {
  kind: "album" | "playlist";
  providerId: string;
  name: string;
  byline: string | null;
  artwork: Artwork;
  trackCount: number;
}

/**
 * What a collection is, in one request — for the look-before-import preview.
 *
 * Walking the items to count them costs a request per ~20 tracks plus Tidal's
 * rate-limit waits: 33 requests and 25 seconds for a 641-track playlist,
 * measured live. The count is on the collection's own record, so the preview
 * reads that and leaves the walk to the import that actually needs it.
 */
export async function fetchTidalCollectionSummary(
  kind: "album" | "playlist",
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TidalCollectionSummary | null> {
  try {
    const path =
      kind === "album"
        ? `/albums/${encodeURIComponent(id)}?include=artists,coverArt`
        : `/playlists/${encodeURIComponent(id)}?include=coverArt`;
    const doc = SingleDocument.parse(await get(path, fetchImpl));
    const index = indexOf(doc.included);
    const coverRef = related(doc.data, "coverArt")[0];
    const artwork = artworkFrom(coverRef ? index.get(`artworks:${coverRef.id}`) : undefined);

    if (kind === "album") {
      const attributes = AlbumAttributes.parse(doc.data.attributes ?? {});
      return {
        kind,
        providerId: doc.data.id,
        name: attributes.title,
        byline: artistsOf(doc.data, index).map((a) => a.name).join(", ") || null,
        artwork,
        trackCount: attributes.numberOfItems ?? 0,
      };
    }
    const attributes = PlaylistAttributes.parse(doc.data.attributes ?? {});
    return {
      kind,
      providerId: doc.data.id,
      name: attributes.name,
      byline: null,
      artwork,
      trackCount: attributes.numberOfTrackItems ?? attributes.numberOfItems ?? 0,
    };
  } catch (error) {
    if (error instanceof TidalUnavailableError && error.reason === "not-found") return null;
    throw error;
  }
}
