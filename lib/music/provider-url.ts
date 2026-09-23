import type { Provider } from "@prisma/client";

/**
 * Where "Open in Spotify" (or Apple Music, or Tidal) goes for a track.
 *
 * The stored `providerUrl` was only ever written by the oEmbed fallback, so a
 * track captured or imported through a provider's API — which is most of them —
 * had an id and no link, and the card silently offered no way back to the
 * music. The id is enough: each provider has one canonical public track page.
 */
export function canonicalTrackUrl(provider: Provider | string, providerId: string): string | null {
  const id = encodeURIComponent(providerId);
  switch (provider) {
    case "spotify":
      return `https://open.spotify.com/track/${id}`;
    case "apple_music":
      return `https://music.apple.com/song/${id}`;
    case "tidal":
      return `https://tidal.com/browse/track/${id}`;
    case "deezer":
      return `https://www.deezer.com/track/${id}`;
    case "musicbrainz":
      return `https://musicbrainz.org/recording/${id}`;
    default:
      return null;
  }
}

/** The stored link when there is one, otherwise the canonical page for the id. */
export function trackUrl(external: {
  provider: Provider | string;
  providerId?: string | null;
  providerUrl?: string | null;
} | null | undefined): string | null {
  if (!external) return null;
  if (external.providerUrl) return external.providerUrl;
  return external.providerId ? canonicalTrackUrl(external.provider, external.providerId) : null;
}
