"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatExperienced } from "@/lib/format-date";
import type { ListenView } from "@/lib/listens/service";
import { shouldApply, shouldPoll } from "@/lib/listens/polling";
import { CoverArt } from "@/components/cover-art";
import type { TrackCandidate } from "@/lib/music/match-track";
import {
  candidatesAction,
  dismissLastfmPromptAction,
  importListenAction,
  recentListensAction,
  type RecentState,
} from "@/app/listens/actions";

/**
 * How often to re-read the feed. Tracks run three to five minutes, so this is
 * responsive without being wasteful — and it is per open tab, against an API
 * that is somebody else's to pay for.
 */
const POLL_MS = 30_000;

/**
 * What you have been listening to, offered as things to write about.
 *
 * This answers "what should I write about?" — the question a blank journal
 * always asks and rarely helps with. You see something you heard this morning,
 * tap it, and capture the association while it is still there.
 *
 * **It loads after the page, not with it.** The contract is explicit that a
 * request handler must not wait on Last.fm, and the notes page is the one screen
 * that has to be fast. So the server renders everything else and this fetches
 * itself afterwards; if Last.fm is slow or down, the strip says so and nothing
 * else on the page is affected.
 *
 * **It then keeps itself current**, the way a Last.fm profile page does — you
 * should not have to reload to see what you just played. Three rules keep that
 * from being rude or disruptive:
 *
 *   - **Never while someone is writing.** An open jot box freezes the list
 *     completely: a refresh that reordered rows mid-sentence, or dropped the
 *     row being written about out of the top ten, would cost somebody their
 *     words. Both the polling and the *applying* of an in-flight reply are
 *     suppressed, so a request that started before they clicked cannot land
 *     underneath them either.
 *   - **Never in a background tab.** Polling somebody else's API while nobody
 *     is looking spends their rate limit for nothing.
 *   - **Immediately on return.** Coming back to the tab, or finishing a jot,
 *     refreshes at once rather than waiting out the interval.
 */
export function Scrobbles({ username }: { username: string }) {
  const [state, setState] = useState<RecentState | null>(null);
  const [writingFor, setWritingFor] = useState<string | null>(null);
  /**
   * Earlier pages, once someone has asked for them.
   *
   * Ten rows is a capture aid for what is playing now; a day of listening is
   * more than ten rows, so somebody sitting down in the evening could find the
   * morning already pushed off the strip. This is the bounded answer to that —
   * one requested page at a time, never a lifetime import.
   *
   * Held separately from `state` on purpose: **polling refreshes only the first
   * page.** Earlier listening does not change, so re-fetching it every thirty
   * seconds would spend somebody else's rate limit to redraw identical rows,
   * and a refresh that collapsed the pages a reader had opened would be its own
   * small betrayal.
   */
  const [earlier, setEarlier] = useState<ListenView[]>([]);
  const [page, setPage] = useState(1);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState<string | null>(null);
  /** Last.fm answered a page with nothing, so there is no more history. */
  const [exhausted, setExhausted] = useState(false);

  /**
   * Read by the polling loop, which must see the *current* value without being
   * torn down and rebuilt every time the editor opens or closes.
   */
  const writing = useRef<string | null>(null);
  const inFlight = useRef(false);

  const beginWriting = useCallback((sourceRef: string | null) => {
    writing.current = sourceRef;
    setWritingFor(sourceRef);
  }, []);

  /**
   * Fetch, without deciding anything. Returning the result rather than storing
   * it keeps the "should this be applied?" question at the call site, where the
   * answer depends on whether someone has since started writing.
   */
  const load = useCallback(async (): Promise<RecentState | null> => {
    // One request at a time. A slow reply must not stack up behind the timer.
    if (inFlight.current) return null;
    inFlight.current = true;
    try {
      return await recentListensAction();
    } catch {
      return { ok: false, message: "Last.fm isn't answering right now." };
    } finally {
      inFlight.current = false;
    }
  }, []);

  /**
   * Apply a reply — unless a jot box opened while it was in flight. That guard
   * is the one that matters: a request begun before the click must not land
   * underneath somebody mid-sentence.
   */
  const apply = useCallback((result: RecentState | null, stopped = false) => {
    if (result && shouldApply({ writing: writing.current, stopped })) setState(result);
  }, []);

  useEffect(() => {
    let stopped = false;

    const tick = () => {
      // The three rules live in `shouldPoll`, stated once and tested directly.
      if (!shouldPoll({ writing: writing.current, hidden: document.hidden, stopped })) return;
      void load().then((result) => apply(result, stopped));
    };

    tick();
    const timer = window.setInterval(tick, POLL_MS);

    // Coming back to the tab should show the truth at once, not in 30 seconds.
    const onVisible = () => {
      if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, apply]);

  /**
   * Fetch the next page of earlier listening and append it.
   *
   * Appended rather than merged into `state` so the polling loop keeps owning
   * the first page alone. An empty reply means the history ran out, which is a
   * fact worth showing rather than a button that keeps promising more.
   */
  const showEarlier = useCallback(async () => {
    if (loadingEarlier) return;
    setLoadingEarlier(true);
    setEarlierError(null);
    const next = page + 1;
    try {
      const result = await recentListensAction(next);
      if (!result.ok) {
        setEarlierError(result.message);
        return;
      }
      // A now-playing row only belongs at the top of the first page; it would
      // be nonsense repeated further down a history.
      const older = result.listens.filter((listen) => listen.playedAt !== null);
      if (older.length === 0) {
        setExhausted(true);
        return;
      }
      setEarlier((current) => [...current, ...older]);
      setPage(next);
      if (next >= 20) setExhausted(true);
    } catch {
      setEarlierError("Last.fm isn’t answering right now.");
    } finally {
      setLoadingEarlier(false);
    }
  }, [loadingEarlier, page]);

  /** Finishing a jot resumes the feed and shows the result immediately. */
  const doneWriting = useCallback(() => {
    beginWriting(null);
    void load().then(apply);
  }, [beginWriting, load, apply]);

  return (
    <section className="scrobbles">
      {/*
        No heading here any more: the panel this sits inside supplies "Recently
        played" and says whose account it is, and printing both produced the
        same words twice. The link to the profile stays, because a summary is a
        control and nesting a link inside one is a trap for anyone trying to
        expand the section.
      */}
      <p className="note scrobbles-source">
        <a
          href={`https://www.last.fm/user/${encodeURIComponent(username)}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          See {username} on Last.fm
        </a>
      </p>

      {state === null && <p className="note">Looking at what you&rsquo;ve been playing…</p>}

      {state?.ok === false && <p className="note">{state.message}</p>}

      {state?.ok && state.listens.length === 0 && (
        <p className="note">Nothing scrobbled yet.</p>
      )}

      {state?.ok && state.listens.length > 0 && (
        <ul className="scrobble-list">
          {visibleListens(state.listens, earlier).map((listen) => (
            <li
              key={listen.sourceRef}
              className={`scrobble${listen.playedAt ? "" : " live"}`}
            >
              <div className="scrobble-main">
                <div className="scrobble-title">
                  {listen.url ? (
                    <a href={listen.url} target="_blank" rel="noopener noreferrer">
                      {listen.trackName}
                    </a>
                  ) : (
                    listen.trackName
                  )}
                </div>
                <div className="note">
                  {listen.artistName}
                  {listen.albumName ? ` · ${listen.albumName}` : ""}
                </div>
                <div className="note scrobble-when">
                  {listen.playedAt ? (
                    formatExperienced(listen.playedAt, "time")
                  ) : (
                    <>
                      {/* Decorative — "Playing now" beside it already says this,
                          so a screen reader is spared three anonymous bars. */}
                      <span className="playing-bars" aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      Playing now
                    </>
                  )}
                </div>
              </div>

              {/*
                "Add note" on every row, always; "View note" beside it once one
                exists. The strip used to replace the button with a bare
                "Jotted" — no way to reach the note, and no way to write a second
                one about a song heard again. Two hearings are two occasions.
                
                The accessible name *contains* the visible words ("Add note about
                …"), so a voice user saying what they see reaches the control.
              */}
              {writingFor !== listen.sourceRef && (
                <span className="scrobble-actions">
                  {listen.recordingId && listen.noteCount > 0 && (
                    <Link
                      href={`/notes?recording=${encodeURIComponent(listen.recordingId)}#notes`}
                      className="scrobble-view"
                      aria-label={`View ${listen.noteCount === 1 ? "note" : `${listen.noteCount} notes`} about ${listen.trackName}`}
                    >
                      {listen.noteCount === 1 ? "View note" : `View ${listen.noteCount} notes`}
                    </Link>
                  )}
                  <button
                    type="button"
                    className="linkish"
                    aria-label={`Add note about ${listen.trackName} by ${listen.artistName}`}
                    onClick={() => beginWriting(listen.sourceRef)}
                  >
                    Add note
                  </button>
                </span>
              )}

              {writingFor === listen.sourceRef && (
                <ScrobbleJot listen={listen} onDone={doneWriting} />
              )}
            </li>
          ))}
        </ul>
      )}

      {/*
        Earlier listening, only when asked for.
        
        A bounded window rather than a history import: each press fetches one
        more page, and the button stops offering when Last.fm runs out or the
        cap is reached. It is deliberately absent while a jot is open — the
        whole strip freezes then, and appending rows underneath somebody
        mid-sentence would be the same disruption polling is suppressed to
        avoid.
      */}
      {state?.ok && state.listens.length > 0 && writingFor === null && (
        <div className="row scrobbles-more">
          {!exhausted && (
            <button type="button" className="linkish" onClick={showEarlier} disabled={loadingEarlier}>
              {loadingEarlier ? "Looking further back…" : "Show earlier listens"}
            </button>
          )}
          {exhausted && (
            <span className="note">That&rsquo;s as far back as this goes.</span>
          )}
          {earlierError && (
            <span role="alert" className="note">
              {earlierError}
            </span>
          )}
        </div>
      )}

      <p className="note">
        Last.fm doesn&rsquo;t license cover art for use here, so these show none until the
        track is identified through a service that does.
      </p>
    </section>
  );
}

/**
 * The jot itself.
 *
 * The listening instant is preserved as the note's date — the reason this
 * integration exists — so a note written tonight about something heard at
 * lunchtime is dated lunchtime, not now.
 */
function ScrobbleJot({ listen, onDone }: { listen: ListenView; onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /**
   * The writing is held in state, not left to the DOM.
   *
   * React resets an uncontrolled field once a form action resolves — and a
   * returned validation error resolves perfectly normally. So a save that came
   * back "write something about it first" or "Last.fm is unreachable" cleared
   * the box, and the sentence someone had just typed was gone at exactly the
   * moment they were being asked to try again. Holding the value means a failed
   * save leaves the writing untouched and the retry is one click.
   */
  const [body, setBody] = useState("");
  /**
   * One key per editor, generated once.
   *
   * It makes the whole save replay-safe: every retry of *this* submission
   * resolves to the same note. Opening a fresh editor mints a fresh key, so
   * deliberately writing a second note about the same song still works.
   */
  const [idempotencyKey] = useState(
    () => `jot_${listen.sourceRef}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  );
  const [candidates, setCandidates] = useState<TrackCandidate[] | null>(null);
  /** Index into `candidates`, or -1 for "none of these". Best match preselected. */
  const [chosen, setChosen] = useState(0);

  /**
   * Suggestions are fetched when the editor opens, not with the strip. Ten rows
   * would mean ten lookups against somebody else's rate limit to answer a
   * question nobody asked.
   */
  useEffect(() => {
    let cancelled = false;
    candidatesAction({ trackName: listen.trackName, artistName: listen.artistName }).then(
      (found) => {
        if (!cancelled) setCandidates(found);
      },
      () => {
        if (!cancelled) setCandidates([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [listen.trackName, listen.artistName]);

  async function save(formData: FormData) {
    setSaving(true);
    setError(null);
    try {
      const result = await importListenAction({}, formData);
      if (result.error) setError(result.error);
      else onDone();
    } catch {
      /**
       * A thrown action — a dropped connection, a server error — used to leave
       * the button stuck on "Saving…" forever with no explanation, because
       * nothing reset the flag. The writing is safe in state either way, so the
       * honest thing to say is that it did not save and can be tried again.
       */
      setError("That didn’t save. Your writing is still here — try again.");
    } finally {
      setSaving(false);
    }
  }

  const pick = candidates && chosen >= 0 ? candidates[chosen] : null;

  return (
    <form action={save} className="scrobble-jot inline-edit">
      <input type="hidden" name="sourceRef" value={listen.sourceRef} />
      {/* Carried so a track still playing — which has no stored row yet — can be
          written down at the moment it matters. */}
      <input type="hidden" name="trackName" value={listen.trackName} />
      <input type="hidden" name="artistName" value={listen.artistName} />
      <input type="hidden" name="albumName" value={listen.albumName ?? ""} />
      <input type="hidden" name="url" value={listen.url ?? ""} />
      {/* Only the identifier travels. Everything else is re-read server-side
          from the provider, so this cannot inject a title or an image URL. */}
      <input type="hidden" name="confirmedProvider" value={pick?.provider ?? ""} />
      <input type="hidden" name="confirmedId" value={pick?.providerId ?? ""} />

      {candidates === null && <p className="note">Looking for this on Apple Music and Spotify…</p>}

      {/* An empty result is a real answer, not a missing one. Saying so beats
          silence, and beats padding the picker with tracks that are visibly not
          this one — which is what it used to do. */}
      {candidates !== null && candidates.length === 0 && (
        <p className="note">
          No confident match on Apple Music or Spotify. Your note is kept as your own
          entry — private to you, and without cover art.
        </p>
      )}

      {candidates !== null && candidates.length > 0 && (
        <fieldset className="sub-fields match-picker">
          <legend>Is this the one?</legend>
          <p className="note">
            Last.fm didn&rsquo;t include an identifier for this play. Confirming a match
            gets you the cover art and links, and files it alongside the same track from
            anywhere else. Nothing is matched for you.
          </p>

          {candidates.map((candidate, index) => (
            <label key={`${candidate.provider}:${candidate.providerId}`} className="match">
              <input
                type="radio"
                name="candidate"
                checked={chosen === index}
                onChange={() => setChosen(index)}
              />
              <CoverArt
                url={candidate.artwork.thumbUrl}
                fullUrl={candidate.artwork.url}
                size={44}
                title={candidate.title}
              />
              <span className="match-text">
                <strong>{candidate.title}</strong>
                <span className="note">
                  {candidate.artistName}
                  {candidate.albumName ? ` · ${candidate.albumName}` : ""}
                </span>
                <span className="note">
                  {candidate.provider === "apple_music" ? "Apple Music" : "Spotify"}
                  {/* Terse on purpose: this line sits beside a 44px cover in a
                      ~265px column on a phone, and the wordier version was the
                      first thing to be ellipsed away. */}
                  {candidate.durationDeltaMs !== null &&
                    ` · within ${(candidate.durationDeltaMs / 1000).toFixed(1)}s`}
                </span>
              </span>
            </label>
          ))}

          <label className="match match-none">
            <input
              type="radio"
              name="candidate"
              checked={chosen === -1}
              onChange={() => setChosen(-1)}
            />
            <span className="match-text">
              <strong>None of these</strong>
              <span className="note">
                Keep it as your own entry — private to you, and no cover art.
              </span>
            </span>
          </label>
        </fieldset>
      )}

      <label className="visually-hidden" htmlFor={`jot-${listen.sourceRef}`}>
        Your note about {listen.trackName}
      </label>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <textarea
        id={`jot-${listen.sourceRef}`}
        name="body"
        rows={3}
        autoFocus
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={`What do you want to remember about ${listen.trackName}?`}
      />

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="row">
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save note"}
        </button>
        <button type="button" className="linkish" onClick={onDone}>
          Cancel
        </button>
        <span className="note">
          Dated {listen.playedAt ? formatExperienced(listen.playedAt, "time") : "now"}
          {pick ? "" : " · stays private to you"}
        </span>
      </div>
    </form>
  );
}

/**
 * The one-time offer to connect a listening history.
 *
 * Shown to someone who has not connected one and has not waved it away. It is
 * dismissible on purpose: an integration that keeps asking is an advertisement.
 */
export function LastfmPrompt() {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;

  return (
    <section className="lastfm-prompt">
      <strong>Connect Last.fm?</strong>
      <p className="note">
        If you scrobble, TrackJot can show what you have been playing so you can note it
        down while it is fresh. You approve it on Last.fm&rsquo;s own site — it is not a
        way to sign in here, and TrackJot never sees your password.
      </p>
      <div className="row">
        <a className="download" href="/api/lastfm/start">
          Connect Last.fm
        </a>
        <button
          type="button"
          className="linkish"
          onClick={async () => {
            setHidden(true);
            await dismissLastfmPromptAction();
          }}
        >
          Not now
        </button>
        <span className="note">
          Or later, from <Link href="/account">your account</Link>.
        </span>
      </div>
    </section>
  );
}

/**
 * The first page plus whatever earlier pages have been asked for, deduplicated.
 *
 * Overlap is expected rather than exceptional: the first page is re-polled
 * every thirty seconds while the earlier pages are frozen, so a play can sit in
 * both — and Last.fm itself shifts rows between pages as new plays arrive. Keyed
 * by `sourceRef`, first occurrence wins, which is the freshly polled one.
 */
function visibleListens(recent: ListenView[], earlier: ListenView[]): ListenView[] {
  const seen = new Set<string>();
  const out: ListenView[] = [];
  for (const listen of [...recent, ...earlier]) {
    if (seen.has(listen.sourceRef)) continue;
    seen.add(listen.sourceRef);
    out.push(listen);
  }
  return out;
}
