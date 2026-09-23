import { describe, expect, it } from "vitest";
import { canonicalTrackUrl, trackUrl } from "./provider-url";

describe("where a track opens", () => {
  it("builds each provider's public track page from the id", () => {
    expect(canonicalTrackUrl("spotify", "4uLU6hMCjMI75M1A2tKUQC")).toBe(
      "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
    );
    expect(canonicalTrackUrl("apple_music", "1440857781")).toBe(
      "https://music.apple.com/song/1440857781",
    );
    expect(canonicalTrackUrl("tidal", "77640617")).toBe("https://tidal.com/browse/track/77640617");
  });

  it("prefers a stored link, and falls back to the id when there is none", () => {
    expect(trackUrl({ provider: "spotify", providerId: "x", providerUrl: "https://open.spotify.com/track/y" })).toBe(
      "https://open.spotify.com/track/y",
    );
    expect(trackUrl({ provider: "tidal", providerId: "1", providerUrl: null })).toBe(
      "https://tidal.com/browse/track/1",
    );
    expect(trackUrl(null)).toBeNull();
    expect(trackUrl({ provider: "discogs", providerId: "1" })).toBeNull();
  });

  it("cannot be steered off the provider's site by a crafted id", () => {
    expect(canonicalTrackUrl("spotify", "../../evil.example/x")).toBe(
      "https://open.spotify.com/track/..%2F..%2Fevil.example%2Fx",
    );
  });
});
