import { Provider } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * A ~30 second preview for a recording, when a provider will give us one.
 *
 * ## What actually turned out to be available
 *
 * Spotify is **not** a preview source any more. `preview_url` returns `null`
 * for every track on credentials issued after November 2024, with or without a
 * `market`, which was verified against this deployment's own client before any
 * of this was written. Building a player on it would have shipped a play button
 * that never plays.
 *
 * What does work:
 *
 *   - **Apple Music**, whose public lookup endpoint returns `previewUrl` for a
 *     track id — no credentials, and it is the provider most of this catalog is
 *     anchored to.
 *   - **Deezer, by ISRC.** This is the interesting one: a Spotify-only track
 *     usually still carries an ISRC, and Deezer serves `track/isrc:{code}`
 *     without authentication. So a Spotify note can still have a preview.
 *
 * ## Why this does not violate the catalog policy
 *
 * Deezer is reached **by identifier, never by name** (AGENTS.md §3a). An ISRC
 * is the recording industry's own identifier for a specific recording, so this
 * is an identifier-to-identifier lookup — the same class of move as resolving a
 * Spotify id. Nothing here searches for a title, nothing creates an entity, and
 * a preview is attached to the external-id row it came from rather than
 * promoting anything into the shared catalog.
 */

/** Both providers' preview CDNs, and nothing else. */
const ALLOWED_PREVIEW_HOSTS = new Set([
  "audio-ssl.itunes.apple.com",
  "audio-ssl.mzstatic.com",
  "cdnt-preview.dzcdn.net",
  "cdns-preview-0.dzcdn.net",
  "cdns-preview-1.dzcdn.net",
  "cdns-preview-2.dzcdn.net",
  "cdns-preview-3.dzcdn.net",
  "cdns-preview-4.dzcdn.net",
  "cdns-preview-5.dzcdn.net",
  "cdns-preview-6.dzcdn.net",
  "cdns-preview-7.dzcdn.net",
  "cdns-preview-8.dzcdn.net",
  "cdns-preview-9.dzcdn.net",
  "cdns-preview-a.dzcdn.net",
  "cdns-preview-b.dzcdn.net",
  "cdns-preview-c.dzcdn.net",
  "cdns-preview-d.dzcdn.net",
  "cdns-preview-e.dzcdn.net",
  "cdns-preview-f.dzcdn.net",
]);

const TIMEOUT_MS = 6000;
/** A track with no preview today may have one later; a month is often enough. */
const RECHECK_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A URL is only stored if it is https and on a host we expect.
 *
 * This value ends up in an `<audio src>`, so an unchecked one from a third
 * party is a request the browser makes on the reader's behalf to wherever that
 * party says — the same reasoning as `safeArtwork` for images.
 */
export function safePreview(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    if (!ALLOWED_PREVIEW_HOSTS.has(parsed.hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/** The recording industry's identifier: two letters, three alphanumerics, five
 *  digits of year-and-designation. Validated because it is interpolated. */
const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Apple's public lookup. Numeric ids only — this is interpolated into a URL. */
export async function applePreview(
  trackId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!/^\d+$/.test(trackId)) return null;
  const body = (await getJson(
    `https://itunes.apple.com/lookup?id=${trackId}&entity=song`,
    fetchImpl,
  )) as { results?: Array<{ previewUrl?: string }> } | null;
  return safePreview(body?.results?.[0]?.previewUrl);
}

/** Deezer, addressed by ISRC rather than by anything a person typed. */
export async function deezerPreviewByIsrc(
  isrc: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const code = isrc.trim().toUpperCase();
  if (!ISRC.test(code)) return null;
  const body = (await getJson(`https://api.deezer.com/track/isrc:${code}`, fetchImpl)) as {
    preview?: string;
    error?: unknown;
  } | null;
  if (!body || body.error) return null;
  return safePreview(body.preview);
}

/**
 * Find a playable preview for a recording, remembering the answer either way.
 *
 * The negative result is recorded as deliberately as the positive one: without
 * `previewCheckedAt`, every track that genuinely has no preview would be
 * queried again on every render, so the common case would be the expensive one.
 */
export async function previewForRecording(
  recordingId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const rows = await prisma.recordingExternalId.findMany({
    where: { recordingId },
    select: {
      id: true,
      provider: true,
      providerId: true,
      isrc: true,
      previewUrl: true,
      previewCheckedAt: true,
    },
  });

  const stored = rows.find((r) => r.previewUrl);
  if (stored?.previewUrl) return safePreview(stored.previewUrl);

  const freshlyChecked = rows.some(
    (r) => r.previewCheckedAt && Date.now() - r.previewCheckedAt.getTime() < RECHECK_AFTER_MS,
  );
  if (rows.length === 0 || freshlyChecked) return null;

  // Apple first: it is this catalog's most common anchor, and its answer is
  // about the exact track rather than about a recording that shares an ISRC.
  const apple = rows.find((r) => r.provider === Provider.apple_music);
  if (apple) {
    const url = await applePreview(apple.providerId, fetchImpl);
    if (url) {
      await prisma.recordingExternalId.update({
        where: { id: apple.id },
        data: { previewUrl: url, previewCheckedAt: new Date() },
      });
      return url;
    }
  }

  const withIsrc = rows.find((r) => r.isrc);
  if (withIsrc?.isrc) {
    const url = await deezerPreviewByIsrc(withIsrc.isrc, fetchImpl);
    if (url) {
      await prisma.recordingExternalId.update({
        where: { id: withIsrc.id },
        data: { previewUrl: url, previewCheckedAt: new Date() },
      });
      return url;
    }
  }

  // Nothing found. Record that on every row, so the miss is not re-paid.
  await prisma.recordingExternalId.updateMany({
    where: { recordingId },
    data: { previewCheckedAt: new Date() },
  });
  return null;
}
