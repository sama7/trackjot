import { PrismaClient, Provider, RecordingOrigin } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { previewForRecording } from "@/lib/music/preview";
import { resetDatabase } from "./reset";

const prisma = new PrismaClient();

/**
 * Which stored preview links may be reused, and which must be fetched again.
 *
 * This is the bug that reached a phone. Two tracks showed "Preview wouldn't
 * play"; the two stored **Deezer** links, written two days earlier, returned
 * 403 with an HTML body, while re-resolving the same ISRC produced a different
 * URL that fetched immediately. Apple's links from the same day were all still
 * good.
 *
 * So the rule is not "cache previews" — it is "cache the ones that keep
 * working". A Deezer URL is a cache entry with an expiry; an Apple URL is a
 * fact about the track.
 */

const APPLE_PREVIEW = "https://audio-ssl.itunes.apple.com/itunes-assets/x/mzaf_1.m4a";
const STALE_DEEZER = "https://cdnt-preview.dzcdn.net/api/1/1/s/t/a/l/stale.mp3";
const FRESH_DEEZER = "https://cdnt-preview.dzcdn.net/api/1/1/f/r/e/s/fresh.mp3";

const HOURS = 60 * 60 * 1000;

async function recordingWith(external: {
  provider: Provider;
  providerId: string;
  isrc?: string | null;
  previewUrl?: string | null;
  previewCheckedAt?: Date | null;
}) {
  const recording = await prisma.recording.create({
    data: {
      title: "Test Track",
      artistDisplay: "Test Artist",
      origin: RecordingOrigin.provider,
      normalizedKey: `v1:test artist:test track:${Math.random()}`,
      externalIds: { create: { ...external } },
    },
  });
  return recording.id;
}

/** Deezer answers by ISRC; anything else in this suite is a mistake. */
function deezerReturning(preview: string | null): typeof fetch {
  return (async (url: URL | string) => {
    const href = url.toString();
    if (!href.includes("api.deezer.com")) {
      throw new Error(`unexpected request to ${href}`);
    }
    return new Response(JSON.stringify(preview ? { preview } : { error: { message: "no" } }));
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("reusing a stored preview", () => {
  it("serves an Apple link straight from storage, however old", async () => {
    const id = await recordingWith({
      provider: Provider.apple_music,
      providerId: "1574601348",
      previewUrl: APPLE_PREVIEW,
      previewCheckedAt: new Date(Date.now() - 400 * 24 * HOURS),
    });

    const fetchImpl = vi.fn();
    expect(await previewForRecording(id, fetchImpl as unknown as typeof fetch)).toBe(APPLE_PREVIEW);
    // Stable links are the whole reason to have a cache.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /** The reported failure, stated as a test. */
  it("refetches a Deezer link rather than serving a stale one", async () => {
    const id = await recordingWith({
      provider: Provider.spotify,
      providerId: "abc123",
      isrc: "USQX91900123",
      previewUrl: STALE_DEEZER,
      previewCheckedAt: new Date(Date.now() - 48 * HOURS),
    });

    const url = await previewForRecording(id, deezerReturning(FRESH_DEEZER));

    expect(url).toBe(FRESH_DEEZER);
    const stored = await prisma.recordingExternalId.findFirstOrThrow({
      where: { recordingId: id },
    });
    expect(stored.previewUrl, "the fresh link should replace the dead one").toBe(FRESH_DEEZER);
  });

  /**
   * Still a cache, though: pressing play twice in a minute must not mean two
   * lookups against somebody else's API.
   */
  it("reuses a Deezer link that was fetched moments ago", async () => {
    const id = await recordingWith({
      provider: Provider.spotify,
      providerId: "abc123",
      isrc: "USQX91900123",
      previewUrl: FRESH_DEEZER,
      previewCheckedAt: new Date(Date.now() - 60_000),
    });

    const fetchImpl = vi.fn();
    expect(await previewForRecording(id, fetchImpl as unknown as typeof fetch)).toBe(FRESH_DEEZER);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * The retry after a failed playback. Whatever is stored is by definition the
   * thing that just would not play, so it must not be handed back.
   */
  it("ignores even a recent link when forced", async () => {
    const id = await recordingWith({
      provider: Provider.spotify,
      providerId: "abc123",
      isrc: "USQX91900123",
      previewUrl: STALE_DEEZER,
      previewCheckedAt: new Date(Date.now() - 60_000),
    });

    const url = await previewForRecording(id, deezerReturning(FRESH_DEEZER), true);

    expect(url).toBe(FRESH_DEEZER);
  });

  /** A track nobody serves must not be re-asked about on every render. */
  it("remembers that there was no preview", async () => {
    const id = await recordingWith({
      provider: Provider.spotify,
      providerId: "abc123",
      isrc: "USQX91900123",
      previewUrl: null,
      previewCheckedAt: new Date(Date.now() - 2 * HOURS),
    });

    const fetchImpl = vi.fn();
    expect(await previewForRecording(id, fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
