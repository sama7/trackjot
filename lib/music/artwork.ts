/**
 * Cover art, as links.
 *
 * **We store provider URLs, never bytes.** Rehosting images would mean
 * copyright exposure, storage that grows with the size of the catalog rather
 * than with how much the product is used, and a cache to invalidate. The cost
 * of linking is link rot — and that degrades to a missing image, not a broken
 * page, which is the right failure for something decorative.
 *
 * Two sizes are kept because the product genuinely needs both: a full-size
 * image on a collection or track page, and a thumbnail per row in a fifty-track
 * list where pulling fifty 640px images would be indefensible.
 *
 * The providers differ in a way worth naming, because it decides the shape of
 * this module:
 *
 *   - **Spotify** returns a fixed set of renditions (typically 640, 300, 64).
 *     We pick from what exists and cannot ask for another size.
 *   - **Apple** returns a *template* with `{w}` and `{h}` placeholders, so any
 *     size can be requested. That is strictly better and we use it.
 */

export interface Artwork {
  /** Largest sensible rendition, for a page hero. */
  url: string | null;
  /** Small rendition for list rows. */
  thumbUrl: string | null;
}

export const NO_ARTWORK: Artwork = { url: null, thumbUrl: null };

/** What Spotify puts in an `images` array. */
export interface SpotifyImage {
  url?: string;
  width?: number | null;
  height?: number | null;
}

const FULL = 640;

/**
 * Thumbnails are requested at 300px and *displayed* around 48–56px.
 *
 * That is deliberate over-fetching. A phone is a 3x display, so a 56px slot
 * needs a 168px source before it stops looking soft, and a 64px image — the
 * smallest rendition Spotify offers, which this used to pick — is visibly
 * blurry on any modern handset. 300 is the next rendition Spotify actually
 * publishes, so choosing it costs one size step and nothing in round trips.
 */
const THUMB = 300;

/**
 * Pick a full-size and a thumbnail rendition from Spotify's fixed set.
 *
 * Spotify orders images widest-first, but that is a convention rather than a
 * guarantee, so this sorts rather than trusting the order.
 */
export function fromSpotifyImages(images: SpotifyImage[] | undefined): Artwork {
  const usable = (images ?? [])
    .filter((i): i is { url: string; width: number | null; height: number | null } =>
      Boolean(i?.url),
    )
    .map((i) => ({ url: i.url, width: i.width ?? 0 }))
    .sort((a, b) => b.width - a.width);

  if (usable.length === 0) return NO_ARTWORK;

  const largest = usable[0]!;
  // The smallest rendition at or above THUMB; failing that, simply the largest.
  const small = [...usable].reverse().find((i) => i.width >= THUMB) ?? largest;

  return { url: largest.url, thumbUrl: small.url };
}

/**
 * Expand Apple's templated artwork URL.
 *
 * The template looks like `…/{w}x{h}bb.jpg`. Requesting exactly the sizes we
 * render avoids shipping a 3000px master to a 64px row.
 */
export function fromAppleTemplate(template: string | undefined | null): Artwork {
  if (!template || !template.includes("{w}")) return NO_ARTWORK;
  const at = (size: number) =>
    template.replace("{w}", String(size)).replace("{h}", String(size));
  return { url: at(FULL), thumbUrl: at(THUMB) };
}

/**
 * Resize one of iTunes' fixed `artworkUrl100` links.
 *
 * The public lookup API returns a concrete 100px URL rather than a template,
 * but the size is expressed in the path — swapping it works and is the only way
 * to get a usable full-size image from that endpoint. If the shape ever changes
 * this degrades to using the 100px image for both, which is correct-but-small
 * rather than broken.
 */
export function fromItunesArtwork(url100: string | undefined | null): Artwork {
  if (!url100) return NO_ARTWORK;
  const swap = (size: number) => url100.replace(/\/\d+x\d+bb\./, `/${size}x${size}bb.`);
  const full = swap(FULL);
  return {
    url: full === url100 ? url100 : full,
    thumbUrl: swap(THUMB),
  };
}

/**
 * Only ever render art we fetched from a provider we talk to.
 *
 * A recording can be created from user-typed metadata, and a future import path
 * could carry a URL from somewhere else entirely. Rendering an arbitrary
 * attacker-supplied URL in an `<img>` leaks the viewer's IP to that host and
 * makes the page a tracking beacon, so the host is checked before display.
 */
const ALLOWED_ARTWORK_HOSTS = [
  "i.scdn.co",
  "mosaic.scdn.co",
  "image-cdn-ak.spotifycdn.com",
  "image-cdn-fa.spotifycdn.com",
  "is1-ssl.mzstatic.com",
  "is2-ssl.mzstatic.com",
  "is3-ssl.mzstatic.com",
  "is4-ssl.mzstatic.com",
  "is5-ssl.mzstatic.com",
  "resources.tidal.com",
];

export function isDisplayableArtwork(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    return ALLOWED_ARTWORK_HOSTS.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
    );
  } catch {
    return false;
  }
}

/** The URL to render, or null when it is missing or not from a known host. */
export function safeArtwork(url: string | null | undefined): string | null {
  return isDisplayableArtwork(url) ? (url as string) : null;
}
