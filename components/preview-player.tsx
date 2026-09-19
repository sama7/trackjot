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
let audibleId: string | null = null;

/**
 * How a player is told to put itself away.
 *
 * Pausing the previous track was not enough: it stayed expanded, so a list
 * ended up with several sets of transport controls, only one of them live. The
 * previous player now goes all the way back to a single play button, which is
 * both tidier and honest — a collapsed player is one that is not playing.
 */
const collapsers = new Map<string, () => void>();

function claimAudio(id: string, element: HTMLAudioElement) {
  /**
   * Fold away **every** other player, not just the one that was audible.
   *
   * The first version collapsed `audibleId`, and `audibleId` is cleared when a
   * clip reaches its end. So listening to a preview all the way through and
   * then starting another left the finished one sitting there fully expanded,
   * with a progress bar showing a track that had stopped — which is exactly
   * what happened on the phone. Whether the previous player was still making
   * noise is not the question; whether it is still the one you are listening to
   * is, and after this call it is not.
   */
  for (const [otherId, collapse] of collapsers) {
    if (otherId !== id) collapse();
  }
  if (audible && audible !== element) audible.pause();
  audible = element;
  audibleId = id;
}

function releaseAudio(id: string, element: HTMLAudioElement) {
  if (audible === element) audible = null;
  if (audibleId === id) audibleId = null;
}

/**
 * What the phone's lock screen and Control Centre show.
 *
 * Without this, iOS falls back to the document title, so a preview announced
 * itself as "Your notes · TrackJot" — the page, not the music. The track and
 * the artist are what someone glancing at a lock screen wants; TrackJot goes in
 * the album slot, which is where iOS puts the quietest of the three lines.
 *
 * The seek handlers matter too: without them the system's skip buttons are
 * dead, and they are the only transport controls available from a locked phone.
 */
function describeToSystem(
  track: { title: string; artist: string | null; artwork: string | null },
  onSeek: (by: number) => void,
  step: number,
) {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  try {
    /**
     * TrackJot goes on the artist line, because iOS only shows two.
     *
     * The lock screen renders the title and the artist and stops; `album` is
     * not drawn there, so naming the app in that field left the sheet looking
     * like it came from nowhere in particular. Appending it to the artist is
     * the only slot that is actually read out, and it answers the question a
     * glance at a lock screen asks — what is this, and where is it coming from.
     */
    const credit = track.artist ? `${track.artist} · TrackJot` : "TrackJot";

    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: credit,
      album: "TrackJot",
      // Sizes stated so the system picks a rendition instead of guessing; the
      // provider CDNs serve squares, which is what every surface wants.
      artwork: track.artwork
        ? [{ src: track.artwork, sizes: "512x512", type: "image/jpeg" }]
        : [],
    });
    navigator.mediaSession.setActionHandler("seekbackward", () => onSeek(-step));
    navigator.mediaSession.setActionHandler("seekforward", () => onSeek(step));
  } catch {
    // An older browser, or one that refuses a handler. The in-page controls
    // are unaffected, which is the part that has to work.
  }
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
  artist,
  artwork,
  resolve,
}: {
  noteId: string;
  /** Named in the controls, so a screen reader hears which track they drive. */
  title: string;
  /** Shown on the lock screen, where "who is this" is the second question. */
  artist?: string | null;
  artwork?: string | null;
  resolve: (noteId: string, force?: boolean) => Promise<{ url: string | null }>;
}) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const audio = useRef<HTMLAudioElement>(null);
  const toggle_ = useRef<HTMLButtonElement>(null);

  // A note can be deleted, or the list re-rendered by a filter, while its
  // preview is still playing — and audio from a card that is no longer on
  // screen has no way to be stopped.
  useEffect(() => {
    const element = audio.current;
    return () => {
      if (element) {
        element.pause();
        releaseAudio(noteId, element);
      }
    };
  }, [state.kind, noteId]);

  /**
   * Register how this player collapses, so whoever plays next can fold it away.
   * Keyed by note id, which is unique on the page and stable across renders.
   */
  useEffect(() => {
    collapsers.set(noteId, () => {
      audio.current?.pause();
      setPlaying(false);
      setPosition(0);
      setState({ kind: "idle" });
    });
    return () => {
      collapsers.delete(noteId);
    };
  }, [noteId]);

  async function start(force = false) {
    if (state.kind === "loading") return;
    setState({ kind: "loading" });
    try {
      const { url } = await resolve(noteId, force);
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
    /**
     * Move focus onto play/pause.
     *
     * The button that was pressed is replaced by three, and the browser hands
     * focus to whatever lands first in the DOM — which is "back 5 seconds", so
     * the ring appeared on a skip control nobody asked for. Play/pause is the
     * continuation of the press that got here.
     */
    toggle_.current?.focus({ preventScroll: true });
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
        {/* Forced, because the usual reason a link fails to play is that the
            cached one has gone stale — handing back the same URL would fail
            exactly the same way. */}
        <button type="button" className="linkish" onClick={() => start(true)}>
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
          onClick={() => start()}
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
          claimAudio(noteId, event.currentTarget);
          setPlaying(true);
          describeToSystem({ title, artist: artist ?? null, artwork: artwork ?? null }, skip, STEP_SECONDS);
        }}
        onPause={() => setPlaying(false)}
        onEnded={(event) => {
          releaseAudio(noteId, event.currentTarget);
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
        ref={toggle_}
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

/**
 * A circular arrow turning back on itself, with the step size inside it.
 *
 * Built to the same idea as the system's own skip buttons: a ring that fills
 * the icon, a clear break at the top between the arrowhead and the tail it is
 * chasing, and a numeral big enough to read at a glance rather than a detail
 * you have to look for.
 *
 * Geometry, since two earlier attempts got it wrong: the ring is centred at
 * (12, 13) with radius 7.8, so the numeral's optical centre is that point and
 * not the middle of the viewBox. The arc runs from -60° clockwise the long way
 * to -120°, which leaves a 60° gap across the top; the head sits at one side of
 * that gap and the tail at the other, so the two never touch.
 */
function Replay5() {
  return (
    <svg className="preview-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M15.9 6.25A7.8 7.8 0 1 1 8.1 6.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M9.6 3.1v6.3L4.9 6.25z" fill="currentColor" />
      <text className="preview-icon-step" x="12" y="17.6" textAnchor="middle">
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
        d="M8.1 6.25A7.8 7.8 0 1 0 15.9 6.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M14.4 3.1v6.3l4.7-3.15z" fill="currentColor" />
      <text className="preview-icon-step" x="12" y="17.6" textAnchor="middle">
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
