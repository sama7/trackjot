import { PrismaClient, Provider } from "@prisma/client";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureFromLink } from "@/lib/music/capture-track";
import { importFromTidalLink } from "@/lib/music/import-from-tidal";
import { previewLink } from "@/lib/music/preview-link";
import type { ImportableCollection, ImportableTrack } from "@/lib/music/importable";
import { resetDatabase } from "./reset";

const prisma = new PrismaClient();

/**
 * Tidal, end to end through the same resolution path as every other provider.
 *
 * The provider calls are injected with synthetic data in Tidal's shapes; the
 * wire format itself is covered by `lib/music/tidal/api.test.ts`. What these
 * prove is the part that matters to a user: a Tidal track becomes one
 * recording with linked artists and an ISRC (which is what finds its preview),
 * pasting it again costs no network call, a playlist keeps its order and its
 * duplicates, and with no credentials nothing is created.
 */

const PLAYLIST_ID = "0f8f4b1e-5c2a-4d3b-9e7f-1a2b3c4d5e6f";

function tidalTrack(id: string, name: string): ImportableTrack {
  return {
    providerId: id,
    name,
    artistDisplay: "Joe James, Guest",
    artists: [
      { providerId: "11", name: "Joe James" },
      { providerId: "12", name: "Guest" },
    ],
    durationMs: 205_000,
    isrc: `QZ${id.padStart(10, "0")}`,
    trackNumber: null,
    artwork: { url: "https://resources.tidal.com/images/a/1280x1280.jpg", thumbUrl: null },
    album: {
      providerId: "500",
      name: "Layers",
      artists: [{ providerId: "11", name: "Joe James" }],
      releaseDate: "2024-03-01",
    },
  };
}

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterEach(() => {
  delete process.env.TIDAL_CLIENT_ID;
  delete process.env.TIDAL_CLIENT_SECRET;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("capturing a Tidal track", () => {
  it("creates one linked recording, then answers from the database", async () => {
    const fetchTidalTrackImpl = vi.fn(async (id: string) => tidalTrack(id, "Layer 6"));
    const link = "https://tidal.com/browse/track/77640617/u";

    const first = await captureFromLink(link, { fetchTidalTrackImpl });
    const second = await captureFromLink(link, { fetchTidalTrackImpl });

    expect(first).toMatchObject({ ok: true, source: "provider", linked: true });
    expect(second).toMatchObject({ ok: true, source: "database" });
    expect(fetchTidalTrackImpl).toHaveBeenCalledTimes(1);

    const mapping = await prisma.recordingExternalId.findUniqueOrThrow({
      where: { provider_providerId: { provider: Provider.tidal, providerId: "77640617" } },
      include: { recording: { include: { artists: { include: { artist: true } } } } },
    });
    expect(mapping.isrc).toBe("QZ0077640617");
    expect(mapping.providerUrl).toBe("https://tidal.com/browse/track/77640617");
    expect(mapping.recording.artists.map((a) => a.artist.name)).toEqual(["Joe James", "Guest"]);
    // Artists and the album come from Tidal ids, never from names.
    expect(await prisma.artistExternalId.count({ where: { provider: Provider.tidal } })).toBe(2);
    expect(await prisma.albumExternalId.count({ where: { provider: Provider.tidal } })).toBe(1);
  });

  it("refuses album and playlist links as notes, and says they import", async () => {
    const outcome = await captureFromLink(`https://tidal.com/browse/playlist/${PLAYLIST_ID}`);
    expect(outcome).toMatchObject({ ok: false, reason: "collection" });
  });

  it("creates nothing and says so when Tidal is not configured", async () => {
    const outcome = await captureFromLink("https://tidal.com/browse/track/1");
    expect(outcome).toMatchObject({ ok: false, reason: "provider-unavailable" });

    const preview = await previewLink(`https://tidal.com/browse/playlist/${PLAYLIST_ID}`);
    expect(preview.kind).toBe("unavailable");
    expect(await prisma.recording.count()).toBe(0);
    expect(await prisma.collection.count()).toBe(0);
  });
});

describe("importing a Tidal playlist", () => {
  it("keeps order and duplicates as one snapshot", async () => {
    const user = await prisma.user.create({ data: { authSubject: `s_${crypto.randomUUID()}` } });
    const playlist: ImportableCollection = {
      provider: Provider.tidal,
      providerId: PLAYLIST_ID,
      kind: "playlist",
      name: "Night drive",
      description: null,
      sourceUrl: `https://tidal.com/browse/playlist/${PLAYLIST_ID}`,
      truncated: false,
      tracks: [tidalTrack("1", "One"), tidalTrack("2", "Two"), tidalTrack("1", "One")],
    };

    const outcome = await importFromTidalLink(
      user.id,
      `https://listen.tidal.com/playlist/${PLAYLIST_ID}`,
      { fetchPlaylistImpl: async () => playlist },
    );

    expect(outcome).toMatchObject({ ok: true, summary: { imported: 3, created: 2, matched: 1 } });
    if (!outcome.ok) return;
    const items = await prisma.collectionItem.findMany({
      where: { collectionId: outcome.summary.collectionId },
      orderBy: { position: "asc" },
      include: { recording: true },
    });
    expect(items.map((i) => i.recording.title)).toEqual(["One", "Two", "One"]);
    expect(items[0]!.recordingId).toBe(items[2]!.recordingId);
  });

  it("explains a private playlist and creates nothing", async () => {
    const user = await prisma.user.create({ data: { authSubject: `s_${crypto.randomUUID()}` } });
    const outcome = await importFromTidalLink(user.id, `https://tidal.com/playlist/${PLAYLIST_ID}`, {
      fetchPlaylistImpl: async () => null,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "not-found" });
    expect((outcome as { message: string }).message).toMatch(/private/);
    expect(await prisma.collection.count()).toBe(0);
  });
});
