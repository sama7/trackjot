import { describe, expect, it, vi } from "vitest";
import { applePreview, deezerPreviewByIsrc, safePreview } from "./preview";

/**
 * Previews, and the two rules that keep them from being a liability.
 *
 * A preview URL ends up in an `<audio src>`, which is a request the browser
 * makes on the reader's behalf. And the lookups interpolate identifiers into
 * URLs, so those identifiers have to be identifiers.
 */

function stub(body: unknown, ok = true): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status: ok ? 200 : 404 })) as unknown as typeof fetch;
}

describe("accepting a preview URL", () => {
  it("takes the providers' own preview CDNs", () => {
    expect(safePreview("https://audio-ssl.itunes.apple.com/x/mzaf_1.m4a")).toContain("mzaf_1");
    expect(safePreview("https://cdnt-preview.dzcdn.net/api/1/1/a.mp3")).toContain("dzcdn");
  });

  it("refuses anywhere else, however plausible", () => {
    for (const url of [
      "https://evil.example/preview.mp3",
      // A lookalike host: the check is equality, not a suffix match.
      "https://audio-ssl.itunes.apple.com.evil.example/x.m4a",
      "http://audio-ssl.itunes.apple.com/x.m4a",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "",
    ]) {
      expect(safePreview(url), `${url} should be refused`).toBeNull();
    }
  });
});

describe("Deezer by ISRC", () => {
  it("looks up a well-formed code", async () => {
    const url = await deezerPreviewByIsrc(
      "USUG11904206",
      stub({ preview: "https://cdnt-preview.dzcdn.net/api/1/1/b.mp3" }),
    );
    expect(url).toContain("dzcdn.net");
  });

  /**
   * The code is interpolated into the request path, so anything that is not an
   * ISRC never reaches the network at all.
   */
  it("never calls out for something that is not an ISRC", async () => {
    const fetchImpl = vi.fn();
    for (const bad of ["", "not-an-isrc", "../../etc/passwd", "US-UG1-19-04206", "USUG1190420"]) {
      expect(await deezerPreviewByIsrc(bad, fetchImpl as unknown as typeof fetch)).toBeNull();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treats Deezer's error body as no preview", async () => {
    expect(
      await deezerPreviewByIsrc("USUG11904206", stub({ error: { message: "no data" } })),
    ).toBeNull();
  });
});

describe("Apple by track id", () => {
  it("reads the preview out of a lookup", async () => {
    const url = await applePreview(
      "1574601348",
      stub({ results: [{ previewUrl: "https://audio-ssl.itunes.apple.com/x/mzaf_2.m4a" }] }),
    );
    expect(url).toContain("mzaf_2");
  });

  it("refuses a non-numeric id without calling out", async () => {
    const fetchImpl = vi.fn();
    expect(await applePreview("abc", fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(await applePreview("1; DROP TABLE", fetchImpl as unknown as typeof fetch)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is null when Apple knows the track but serves no preview", async () => {
    expect(await applePreview("1574601348", stub({ results: [{}] }))).toBeNull();
  });
});
