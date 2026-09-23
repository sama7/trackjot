import { describe, expect, it } from "vitest";
import { parseTidalLink } from "./parse-link";

const PLAYLIST = "0f8f4b1e-5c2a-4d3b-9e7f-1a2b3c4d5e6f";

describe("parseTidalLink — accepted forms", () => {
  it("reads a track from the browse, bare and listen hosts", () => {
    for (const url of [
      "https://tidal.com/browse/track/77640617",
      "https://tidal.com/track/77640617",
      "https://tidal.com/track/77640617/u",
      "https://www.tidal.com/browse/track/77640617?u",
      "https://listen.tidal.com/track/77640617",
    ]) {
      expect(parseTidalLink(url)).toEqual({
        kind: "track",
        id: "77640617",
        canonicalUrl: "https://tidal.com/browse/track/77640617",
      });
    }
  });

  it("reads a track inside its album as the track", () => {
    expect(parseTidalLink("https://listen.tidal.com/album/77640616/track/77640617")).toMatchObject({
      kind: "track",
      id: "77640617",
    });
  });

  it("reads albums, artists and UUID playlists", () => {
    expect(parseTidalLink("https://tidal.com/browse/album/77640616")).toMatchObject({
      kind: "album",
      id: "77640616",
    });
    expect(parseTidalLink("https://tidal.com/browse/artist/3346")).toMatchObject({ kind: "artist" });
    expect(parseTidalLink(`https://tidal.com/browse/playlist/${PLAYLIST}`)).toMatchObject({
      kind: "playlist",
      id: PLAYLIST,
      canonicalUrl: `https://tidal.com/browse/playlist/${PLAYLIST}`,
    });
  });

  it("finds the link inside pasted share text", () => {
    expect(
      parseTidalLink("Listen to Layer 6 on TIDAL https://tidal.com/browse/track/77640617/u"),
    ).toMatchObject({ kind: "track", id: "77640617" });
  });
});

describe("parseTidalLink — refusals", () => {
  it("refuses look-alike and foreign hosts", () => {
    for (const url of [
      "https://tidal.com.evil.example/browse/track/1",
      "https://eviltidal.com/browse/track/1",
      "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
      "not a link",
    ]) {
      expect(parseTidalLink(url)).toEqual({ kind: "unsupported" });
    }
  });

  it("refuses malformed ids rather than passing them to the API", () => {
    expect(parseTidalLink("https://tidal.com/browse/track/abc")).toEqual({ kind: "unsupported" });
    expect(parseTidalLink("https://tidal.com/browse/playlist/12345")).toEqual({ kind: "unsupported" });
    expect(parseTidalLink("https://tidal.com/browse/track/1/extra/2")).toEqual({ kind: "unsupported" });
  });

  it("recognises short links without following them", () => {
    expect(parseTidalLink("https://tidal.link/abc123")).toEqual({ kind: "short-link" });
  });
});
