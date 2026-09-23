/**
 * Parsing Tidal links.
 *
 * The same boundary as the Spotify and Apple parsers: only official Tidal
 * hosts are recognised, and nothing a user pastes is ever fetched as a URL —
 * we extract an id and ask Tidal's API about the id.
 *
 * Tidal shares links in several shapes, all of which people paste:
 *
 *   https://tidal.com/browse/track/77640617
 *   https://tidal.com/track/77640617/u            (the share sheet's "/u")
 *   https://listen.tidal.com/album/77640616/track/77640617
 *   https://tidal.com/browse/album/77640616
 *   https://tidal.com/browse/playlist/0f8f4b1e-…  (playlists are UUIDs)
 *
 * `tidal.link/…` short links are recognised and refused with a reason rather
 * than followed: resolving them means fetching a URL a user supplied.
 */

const HOSTS = new Set(["tidal.com", "www.tidal.com", "listen.tidal.com"]);
const SHORT_HOSTS = new Set(["tidal.link"]);

const NUMERIC = /^\d{1,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TidalEntity = "track" | "album" | "playlist" | "artist";

export type TidalRef =
  | { kind: TidalEntity; id: string; canonicalUrl: string }
  | { kind: "short-link" }
  | { kind: "unsupported" };

export function tidalUrlFor(kind: TidalEntity, id: string): string {
  return `https://tidal.com/browse/${kind}/${id}`;
}

export function parseTidalLink(input: string): TidalRef {
  const trimmed = input.trim();
  // Share text often wraps the link in a sentence; take the first URL in it.
  const candidate = trimmed.match(/https?:\/\/\S+/i)?.[0] ?? trimmed;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { kind: "unsupported" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { kind: "unsupported" };

  const host = url.hostname.toLowerCase();
  if (SHORT_HOSTS.has(host)) return { kind: "short-link" };
  if (!HOSTS.has(host)) return { kind: "unsupported" };

  let segments = url.pathname.split("/").filter(Boolean).map((s) => s.toLowerCase());
  if (segments[0] === "browse") segments = segments.slice(1);
  // A trailing "/u" is the share sheet's marker, not part of the id.
  if (segments.at(-1) === "u") segments = segments.slice(0, -1);

  // album/{albumId}/track/{trackId} names a track inside its album.
  if (segments[0] === "album" && segments[2] === "track") segments = segments.slice(2);

  const [kind, rawId] = segments;
  if (!kind || !rawId || segments.length !== 2) return { kind: "unsupported" };

  switch (kind) {
    case "track":
    case "album":
    case "artist":
      return NUMERIC.test(rawId)
        ? { kind, id: rawId, canonicalUrl: tidalUrlFor(kind, rawId) }
        : { kind: "unsupported" };
    case "playlist":
      return UUID.test(rawId)
        ? { kind, id: rawId, canonicalUrl: tidalUrlFor(kind, rawId) }
        : { kind: "unsupported" };
    default:
      return { kind: "unsupported" };
  }
}
