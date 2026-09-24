import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TidalUnavailableError,
  durationToMs,
  fetchTidalAlbum,
  fetchTidalPlaylist,
  fetchTidalTrack,
  resetTidalToken,
  setTidalSleepForTests,
} from "./api";

/**
 * Synthetic JSON:API fixtures in the shapes of Tidal's published OpenAPI spec
 * (v1.10.134): resource objects with `attributes` and `relationships`, related
 * resources flattened into `included`, and `links.next` for pagination.
 */

const ART = {
  id: "art1",
  type: "artworks",
  attributes: {
    mediaType: "IMAGE",
    files: [
      { href: "https://resources.tidal.com/images/a/b/c/80x80.jpg", meta: { width: 80, height: 80 } },
      { href: "https://resources.tidal.com/images/a/b/c/320x320.jpg", meta: { width: 320, height: 320 } },
      { href: "https://resources.tidal.com/images/a/b/c/1280x1280.jpg", meta: { width: 1280, height: 1280 } },
    ],
  },
};
const ARTIST_A = { id: "11", type: "artists", attributes: { name: "Joe James", popularity: 0.4 } };
const ARTIST_B = { id: "12", type: "artists", attributes: { name: "Guest", popularity: 0.2 } };
const ALBUM = {
  id: "500",
  type: "albums",
  attributes: { title: "Layers", releaseDate: "2024-03-01", albumType: "ALBUM", numberOfItems: 2 },
  relationships: {
    artists: { data: [{ id: "11", type: "artists" }] },
    coverArt: { data: [{ id: "art1", type: "artworks" }] },
  },
};

function track(id: string, title: string, extra: Record<string, unknown> = {}, artists = ["11"]) {
  return {
    id,
    type: "tracks",
    attributes: { title, isrc: `QZ${id.padStart(10, "0")}`, duration: "PT3M25S", explicit: false, ...extra },
    relationships: {
      artists: { data: artists.map((a) => ({ id: a, type: "artists" })) },
      albums: { data: [{ id: "500", type: "albums" }] },
    },
  };
}

type Route = (url: URL) => { status?: number; body?: unknown } | undefined;

function fakeFetch(route: Route) {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    if (url.hostname === "auth.tidal.com") {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    }
    const answer = route(url) ?? { status: 404, body: { errors: [] } };
    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

const slept: number[] = [];

beforeEach(() => {
  slept.length = 0;
  setTidalSleepForTests(async (ms) => {
    slept.push(ms);
  });
  process.env.TIDAL_CLIENT_ID = "id";
  process.env.TIDAL_CLIENT_SECRET = "secret";
  resetTidalToken();
});

afterEach(() => {
  delete process.env.TIDAL_CLIENT_ID;
  delete process.env.TIDAL_CLIENT_SECRET;
  delete process.env.TIDAL_COUNTRY_CODE;
});

describe("durations", () => {
  it("reads ISO 8601", () => {
    expect(durationToMs("PT3M25S")).toBe(205_000);
    expect(durationToMs("PT1H2M3.5S")).toBe(3_723_500);
    expect(durationToMs("PT45S")).toBe(45_000);
    expect(durationToMs("3:25")).toBeNull();
  });
});

describe("a single track", () => {
  it("assembles artists, album, ISRC and art from the compound document", async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.pathname === "/v2/tracks/77640617"
        ? {
            body: {
              data: track("77640617", "Layer 6", { version: "Remastered" }, ["11", "12"]),
              included: [ARTIST_A, ARTIST_B, ALBUM, ART],
            },
          }
        : undefined,
    );

    const result = await fetchTidalTrack("77640617", impl);

    expect(result).toMatchObject({
      providerId: "77640617",
      name: "Layer 6 (Remastered)",
      artistDisplay: "Joe James, Guest",
      artists: [
        { providerId: "11", name: "Joe James" },
        { providerId: "12", name: "Guest" },
      ],
      durationMs: 205_000,
      isrc: "QZ0077640617",
      album: {
        providerId: "500",
        name: "Layers",
        releaseDate: "2024-03-01",
        artists: [{ providerId: "11", name: "Joe James" }],
      },
      artwork: {
        url: "https://resources.tidal.com/images/a/b/c/1280x1280.jpg",
        thumbUrl: "https://resources.tidal.com/images/a/b/c/320x320.jpg",
      },
    });
    const api = new URL(calls.find((c) => c.includes("openapi"))!);
    expect(api.searchParams.get("countryCode")).toBe("US");
    expect(api.searchParams.get("include")).toBe("artists,albums.artists,albums.coverArt");
  });

  it("returns null for a track Tidal does not have", async () => {
    const { impl } = fakeFetch(() => undefined);
    expect(await fetchTidalTrack("1", impl)).toBeNull();
  });

  it("uses the configured storefront", async () => {
    process.env.TIDAL_COUNTRY_CODE = "gb";
    const { impl, calls } = fakeFetch(() => ({ body: { data: track("1", "x"), included: [ARTIST_A] } }));
    await fetchTidalTrack("1", impl);
    expect(new URL(calls.at(-1)!).searchParams.get("countryCode")).toBe("GB");
  });

  it("refuses to run unconfigured", async () => {
    delete process.env.TIDAL_CLIENT_ID;
    const { impl } = fakeFetch(() => undefined);
    await expect(fetchTidalTrack("1", impl)).rejects.toMatchObject({ reason: "not-configured" });
  });

  /**
   * Measured live: the fifth rapid page request came back 429 with
   * Retry-After: 4. That means wait, not fail.
   */
  it("waits out a 429 for as long as Retry-After says, then carries on", async () => {
    let calls = 0;
    const impl = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "auth.tidal.com") {
        return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
      }
      calls++;
      if (calls === 1) return new Response("{}", { status: 429, headers: { "retry-after": "4" } });
      return new Response(JSON.stringify({ data: track("1", "After the wait"), included: [ARTIST_A] }));
    }) as typeof fetch;

    const result = await fetchTidalTrack("1", impl);

    expect(result?.name).toBe("After the wait");
    expect(slept).toEqual([4_000]);
  });

  it("gives up on a limit that will not lift, and reports it as a rate limit", async () => {
    const { impl } = fakeFetch(() => ({ status: 429 }));
    const error = await fetchTidalTrack("1", impl).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TidalUnavailableError);
    expect((error as TidalUnavailableError).reason).toBe("rate-limited");
  });
});

describe("a playlist", () => {
  const PLAYLIST = "0f8f4b1e-5c2a-4d3b-9e7f-1a2b3c4d5e6f";

  it("keeps order and duplicates across pages, skips videos, and fills gaps by batch", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.pathname === `/v2/playlists/${PLAYLIST}`) {
        return {
          body: {
            data: {
              id: PLAYLIST,
              type: "playlists",
              attributes: { name: "Night drive", description: "late" },
              relationships: { coverArt: { data: [{ id: "art1", type: "artworks" }] } },
            },
            included: [ART],
          },
        };
      }
      if (url.pathname === `/v2/playlists/${PLAYLIST}/relationships/items`) {
        if (!url.searchParams.get("page[cursor]")) {
          return {
            body: {
              data: [
                { id: "1", type: "tracks" },
                { id: "9", type: "videos" },
                { id: "2", type: "tracks" },
              ],
              included: [track("1", "One"), track("2", "Two"), ARTIST_A, ALBUM, ART],
              links: { self: "x", next: `/playlists/${PLAYLIST}/relationships/items?page[cursor]=abc` },
            },
          };
        }
        return {
          body: {
            // "1" again (a duplicate), and "3", which arrives without its
            // relationships and must be fetched by batch.
            data: [
              { id: "1", type: "tracks" },
              { id: "3", type: "tracks" },
            ],
            included: [{ id: "3", type: "tracks", attributes: { title: "Three", duration: "PT1M" } }],
            links: { self: "x" },
          },
        };
      }
      if (url.pathname === "/v2/tracks") {
        expect(url.searchParams.getAll("filter[id]")).toEqual(["3"]);
        return { body: { data: [track("3", "Three")], included: [ARTIST_A, ALBUM, ART] } };
      }
      return undefined;
    });

    const result = await fetchTidalPlaylist(PLAYLIST, impl);

    expect(result).toMatchObject({
      provider: "tidal",
      kind: "playlist",
      name: "Night drive",
      description: "late",
      sourceUrl: `https://tidal.com/browse/playlist/${PLAYLIST}`,
      truncated: false,
    });
    expect(result!.tracks.map((t) => t.name)).toEqual(["One", "Two", "One", "Three"]);
    expect(result!.tracks[3]!.artistDisplay).toBe("Joe James");
    // The cursor link was followed on the API host, with the country code added.
    const second = calls.find((c) => c.includes("cursor"))!;
    expect(new URL(second).origin).toBe("https://openapi.tidal.com");
    expect(new URL(second).searchParams.get("countryCode")).toBe("US");
  });

  it("returns null for a private or missing playlist", async () => {
    const { impl } = fakeFetch(() => undefined);
    expect(await fetchTidalPlaylist(PLAYLIST, impl)).toBeNull();
  });
});

describe("an album", () => {
  it("carries track numbers from the item metadata", async () => {
    const { impl } = fakeFetch((url) => {
      if (url.pathname === "/v2/albums/500") {
        return { body: { data: ALBUM, included: [ARTIST_A, ART] } };
      }
      if (url.pathname === "/v2/albums/500/relationships/items") {
        return {
          body: {
            data: [
              { id: "1", type: "tracks", meta: { trackNumber: 1, volumeNumber: 1 } },
              { id: "2", type: "tracks", meta: { trackNumber: 2, volumeNumber: 1 } },
            ],
            included: [track("1", "One"), track("2", "Two"), ARTIST_A, ALBUM, ART],
            links: { self: "x" },
          },
        };
      }
      return undefined;
    });

    const result = await fetchTidalAlbum("500", impl);

    expect(result).toMatchObject({ kind: "album", name: "Layers", providerId: "500" });
    expect(result!.tracks.map((t) => t.trackNumber)).toEqual([1, 2]);
    expect(result!.artwork?.url).toContain("1280x1280");
  });
});

describe("a collection summary for the preview", () => {
  it("reads the track count from the playlist itself, in one request", async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.pathname === "/v2/playlists/p1"
        ? {
            body: {
              data: {
                id: "p1",
                type: "playlists",
                attributes: { name: "Wohnzimmer", numberOfItems: 645, numberOfTrackItems: 641 },
                relationships: { coverArt: { data: [{ id: "art1", type: "artworks" }] } },
              },
              included: [ART],
            },
          }
        : undefined,
    );
    const { fetchTidalCollectionSummary } = await import("./api");

    const summary = await fetchTidalCollectionSummary("playlist", "p1", impl);

    expect(summary).toMatchObject({ name: "Wohnzimmer", trackCount: 641, byline: null });
    expect(calls.filter((c) => c.includes("openapi"))).toHaveLength(1);
  });

  it("names an album's artists", async () => {
    const { impl } = fakeFetch((url) =>
      url.pathname === "/v2/albums/500" ? { body: { data: ALBUM, included: [ARTIST_A, ART] } } : undefined,
    );
    const { fetchTidalCollectionSummary } = await import("./api");
    expect(await fetchTidalCollectionSummary("album", "500", impl)).toMatchObject({
      name: "Layers",
      byline: "Joe James",
      trackCount: 2,
    });
  });
});
