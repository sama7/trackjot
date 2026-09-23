// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PreviewPlayer } from "./preview-player";

/**
 * A cached preview link that has expired must heal itself.
 *
 * Deezer's links are signed and short-lived. The server refreshes them on a
 * timer, but a link can still die between being handed out and being played,
 * and the person should not be the one who has to notice and press "retry".
 */

beforeAll(() => {
  // happy-dom's media element does not play; resolve like a browser that does.
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(cleanup);

function renderPlayer(resolve: (id: string, force?: boolean) => Promise<{ url: string | null }>) {
  render(<PreviewPlayer noteId="n1" title="Layer 6" artist="Someone" resolve={resolve} />);
}

async function press(name: RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

function audio(): HTMLAudioElement {
  const element = document.querySelector("audio");
  if (!element) throw new Error("no audio element");
  return element;
}

describe("a preview that will not play", () => {
  it("re-resolves once, forced past the cache, and plays the fresh link", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ url: "https://cdnt-preview.dzcdn.net/stale.mp3" })
      .mockResolvedValueOnce({ url: "https://cdnt-preview.dzcdn.net/fresh.mp3" });
    renderPlayer(resolve);

    await press(/play a preview of layer 6/i);
    expect(audio().getAttribute("src")).toContain("stale");

    await act(async () => {
      fireEvent.error(audio());
    });

    expect(resolve).toHaveBeenLastCalledWith("n1", true);
    expect(audio().getAttribute("src")).toContain("fresh");
    expect(screen.queryByText(/wouldn.t play/i)).toBeNull();
  });

  it("shows the error only when the fresh link fails too, and stops there", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({ url: "https://cdnt-preview.dzcdn.net/stale.mp3" })
      .mockResolvedValueOnce({ url: "https://cdnt-preview.dzcdn.net/also-bad.mp3" });
    renderPlayer(resolve);

    await press(/play a preview of layer 6/i);
    await act(async () => {
      fireEvent.error(audio());
    });
    await act(async () => {
      fireEvent.error(audio());
    });

    expect(resolve).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /wouldn.t play — retry/i })).toBeTruthy();
  });
});
