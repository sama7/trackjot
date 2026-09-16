"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A 30-second preview of the track a note is about.
 *
 * ## What it looks like before you press it
 *
 * One play icon, and nothing else. The skip controls, the progress bar and the
 * level meter only appear once something is actually playing — a row of five
 * controls on every card in a list of fifty is clutter around the thing the
 * card is for, which is the note.
 *
 * ## Why it loads on demand
 *
 * Resolving a preview can mean a call to Apple or Deezer, so a page of fifty
 * notes would otherwise make fifty of them before anyone pressed anything. The
 * first press resolves and plays; the answer is cached server-side against the
 * track, so it is one round trip per track ever, not per visit.
 *
 * ## Why "no preview" is a real state
 *
 * Most tracks here are anchored to Spotify, and **Spotify no longer serves
 * preview URLs** to applications registered after 2024 — verified against this
 * deployment's own credentials. Apple serves them, and Deezer serves them by
 * ISRC, so many Spotify notes still get one. Some genuinely cannot, and saying
 * so once is better than a control that looks live and does nothing.
 */
const STEP_SECONDS = 5;

/**
 * The one preview allowed to be audible.
 *
 * Every player owns its own `<audio>`, and nothing connected them — so playing
 * a second track left the first one going and you heard both at once. A
 * module-level reference is the smallest thing that fixes it: whoever starts
 * playing pauses whoever was playing before. No context, no provider, no
 * subscription; there is exactly one speaker and this models that.
 */
let audible: HTMLAudioElement | null = null;

function claimAudio(element: HTMLAudioElement) {
  if (audible && audible !== element) audible.pause();
  audible = element;
}

function releaseAudio(element: HTMLAudioElement) {
  if (audible === element) audible = null;
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "none" }
  | { kind: "error"; message: string };

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

  // A note can be deleted, or the list re-rendered by a filter, while its
  // preview is still playing — and audio from a card that is no longer on
  // screen has no way to be stopped.
  useEffect(() => {
    const element = audio.current;
    return () => {
      if (element) {
        element.pause();
        releaseAudio(element);
      }
    };
  }, [state.kind]);

  async function start() {
    if (state.kind === "loading") return;
    setState({ kind: "loading" });
    try {
      const { url } = await resolve(noteId);
      setState(url ? { kind: "ready", url } : { kind: "none" });
    } catch {
      setState({ kind: "error", message: "Preview didn’t load" });
    }
  }

  // Autoplay once the source is in place: pressing play is the gesture, and the
  // browser accepts it as one because this runs inside that user event's chain.
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
      <span className="preview-player">
        <button type="button" className="linkish" onClick={start}>
          {state.message} — retry
        </button>
      </span>
    );
  }

  if (state.kind !== "ready") {
    return (
      <span className="preview-player">
        <button
          type="button"
          className="preview-toggle"
          onClick={start}
          disabled={state.kind === "loading"}
          aria-label={`Play a preview of ${title}`}
        >
          {state.kind === "loading" ? <Spinner /> : <PlayIcon />}
        </button>
      </span>
    );
  }

  const percent = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <span className="preview-player" role="group" aria-label={`Preview of ${title}`}>
      <audio
        ref={audio}
        src={state.url}
        preload="auto"
        onPlay={(event) => {
          claimAudio(event.currentTarget);
          setPlaying(true);
        }}
        onPause={() => setPlaying(false)}
        onEnded={(event) => {
          releaseAudio(event.currentTarget);
          setPlaying(false);
          setPosition(0);
        }}
        /**
         * A URL that resolves but will not play — an expired provider link, a
         * CDN refusing the range request, a codec the browser declines. Only
         * *resolving* had an error path before, so this failed silently: the
         * button sat on "play" and nothing ever happened.
         */
        onError={() => {
          setPlaying(false);
          setState({ kind: "error", message: "Preview wouldn’t play" });
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
        <Replay5 />
      </button>

      <button
        type="button"
        className="preview-toggle"
        onClick={toggle}
        aria-label={playing ? `Pause ${title}` : `Play ${title}`}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      <button
        type="button"
        className="preview-step"
        onClick={() => skip(STEP_SECONDS)}
        aria-label={`Forward ${STEP_SECONDS} seconds`}
      >
        <Forward5 />
      </button>

      {/* Decorative: the buttons already announce state, and a bar that
          re-announced itself every 250ms would be unusable with a screen
          reader. */}
      <span className="preview-bar" aria-hidden="true">
        <span className="preview-bar-fill" style={{ width: `${percent}%` }} />
      </span>

      {/*
        The same meter the live scrobble row uses, for the same reason and with
        the same markup — "this is sounding right now" is one idea and should
        not have two visual languages. Present only while playing, so its
        absence is also information.
      */}
      {playing && (
        <span className="playing-bars" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
    </span>
  );
}

/**
 * Icons rather than words.
 *
 * `currentColor` throughout, so they inherit the button's colour in both themes
 * and on hover without a second set of rules. `aria-hidden` because every one
 * of these sits inside a button that already has a label — announcing "5"
 * twice helps nobody.
 */
function PlayIcon() {
  return (
    <svg className="preview-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg className="preview-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z" fill="currentColor" />
    </svg>
  );
}

/** A circular arrow turning back on itself, with the step size inside it. */
function Replay5() {
  return (
    <svg className="preview-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 5V1.5L7.2 6 12 10.5V7a6.5 6.5 0 1 1-6.5 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text className="preview-icon-step" x="12.4" y="17.2" textAnchor="middle">
        5
      </text>
    </svg>
  );
}

/** The same arrow mirrored, so back and forward read as a pair. */
function Forward5() {
  return (
    <svg className="preview-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M12 5V1.5L16.8 6 12 10.5V7a6.5 6.5 0 1 0 6.5 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text className="preview-icon-step" x="11.6" y="17.2" textAnchor="middle">
        5
      </text>
    </svg>
  );
}

/** Deliberately the same circle, un-animated under reduced motion (see CSS). */
function Spinner() {
  return (
    <svg className="preview-icon preview-spinner" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle
        cx="12"
        cy="12"
        r="7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="30 14"
      />
    </svg>
  );
}
