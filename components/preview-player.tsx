"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A 30-second preview of the track a note is about.
 *
 * ## Why it loads on demand
 *
 * Resolving a preview can mean a call to Apple or Deezer, so a page of fifty
 * notes would otherwise make fifty of them before anyone pressed anything. The
 * first press resolves and plays; the answer is cached server-side on the
 * track, so it is one round trip per track ever, not per visit.
 *
 * ## Why "no preview" is a real state and not a hidden button
 *
 * Most tracks here are anchored to Spotify, and **Spotify no longer serves
 * preview URLs** to applications registered after 2024 — verified against this
 * deployment's own credentials. Apple serves them, and Deezer serves them by
 * ISRC, so many Spotify notes still get one. But some genuinely cannot, and
 * saying so once is better than a control that looks live and does nothing.
 *
 * ## Skipping
 *
 * Five seconds, because the clip is thirty: a ten-second step would be a third
 * of the whole thing. Skipping past the end stops rather than wrapping, which
 * is what every other player does and therefore what fingers expect.
 */
const STEP_SECONDS = 5;

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "none" }
  | { kind: "error" };

export function PreviewPlayer({
  noteId,
  title,
  resolve,
}: {
  noteId: string;
  /** Named in the controls, so a screen reader hears which track they drive. */
  title: string;
  resolve: (noteId: string) => Promise<{ url: string | null }>;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);

  // Pausing on unmount matters: a note can be deleted, or the list re-rendered
  // by a filter, while its preview is still playing — and audio from a card
  // that is no longer on screen has no way to be stopped.
  useEffect(() => {
    const element = audio.current;
    return () => element?.pause();
  }, []);

  async function start() {
    if (state.kind === "loading") return;
    setState({ kind: "loading" });
    try {
      const { url } = await resolve(noteId);
      setState(url ? { kind: "ready", url } : { kind: "none" });
    } catch {
      setState({ kind: "error" });
    }
  }

  // Autoplay once the source is in place: pressing Preview is the gesture, and
  // the browser accepts it as one because this runs inside that user event's
  // task chain. A second press to actually hear anything would be silly.
  useEffect(() => {
    if (state.kind !== "ready") return;
    void audio.current?.play().catch(() => setPlaying(false));
  }, [state]);

  function toggle() {
    const element = audio.current;
    if (!element) return;
    if (element.paused) void element.play().catch(() => setPlaying(false));
    else element.pause();
  }

  function skip(by: number) {
    const element = audio.current;
    if (!element) return;
    const next = Math.min(Math.max(element.currentTime + by, 0), element.duration || 30);
    element.currentTime = next;
    setPosition(next);
  }

  if (state.kind === "none") {
    return <span className="note preview-note">No preview available</span>;
  }
  if (state.kind === "error") {
    return (
      <button type="button" className="linkish" onClick={start}>
        Preview didn&rsquo;t load — retry
      </button>
    );
  }
  if (state.kind !== "ready") {
    return (
      <button type="button" className="linkish" onClick={start} disabled={state.kind === "loading"}>
        {state.kind === "loading" ? "Loading preview…" : "Preview"}
      </button>
    );
  }

  const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <span className="preview-player" role="group" aria-label={`Preview of ${title}`}>
      <audio
        ref={audio}
        src={state.url}
        preload="auto"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPosition(0);
        }}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 30)}
      />

      <button
        type="button"
        className="preview-step"
        onClick={() => skip(-STEP_SECONDS)}
        aria-label={`Back ${STEP_SECONDS} seconds`}
      >
        &minus;{STEP_SECONDS}s
      </button>

      <button
        type="button"
        className="preview-toggle"
        onClick={toggle}
        aria-label={playing ? `Pause ${title}` : `Play ${title}`}
      >
        {playing ? "Pause" : "Play"}
      </button>

      <button
        type="button"
        className="preview-step"
        onClick={() => skip(STEP_SECONDS)}
        aria-label={`Forward ${STEP_SECONDS} seconds`}
      >
        +{STEP_SECONDS}s
      </button>

      {/* Decorative: the buttons already announce state, and a bar that
          re-announced itself every 250ms would be unusable with a screen
          reader. */}
      <span className="preview-bar" aria-hidden="true">
        <span className="preview-bar-fill" style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}
