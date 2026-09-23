"use client";

import { useActionState, useState } from "react";
import { CoverArt } from "@/components/cover-art";
import type { CollectionPreview, TrackPreview } from "@/lib/music/preview-link";
import {
  createCollectionFromPreview,
  lookUpLink,
  saveManualNote,
  saveNoteForTrack,
  type LookupState,
  type SaveState,
} from "./capture-actions";

/**
 * Capture, in the order a person actually thinks.
 *
 * The previous form asked for a note before it knew what had been pasted. A
 * playlist link therefore offered a note box that could never be saved, and a
 * track link asked for a title the provider was about to supply anyway — both
 * the same mistake: writing before reading.
 *
 * Now the link is looked up first and the form becomes whatever was found. A
 * track shows its cover and asks for a note. An album or playlist shows its
 * cover and offers to be added, with no note box at all, because a note belongs
 * to a track and there is no honest way to attach one to a fifty-song list from
 * here — the collection page is where that note gets written.
 *
 * Manual entry is a separate mode rather than a set of optional fields. Title
 * and artist inputs sitting beside a link box invite filling in both and then
 * wondering which one won.
 */

type Mode = "link" | "manual";

export function CaptureForm({ providers = "Spotify or Apple Music" }: { providers?: string }) {
  const [mode, setMode] = useState<Mode>("link");

  return (
    <section className="capture-shell">
      <div className="mode-switch" role="tablist" aria-label="How to add music">
        <button
          type="button"
          role="tab"
          id="tab-link"
          aria-selected={mode === "link"}
          aria-controls="panel-link"
          className={mode === "link" ? "mode active" : "mode"}
          onClick={() => setMode("link")}
        >
          Paste a link <span className="mode-hint">preferred</span>
        </button>
        <button
          type="button"
          role="tab"
          id="tab-manual"
          aria-selected={mode === "manual"}
          aria-controls="panel-manual"
          className={mode === "manual" ? "mode active" : "mode"}
          onClick={() => setMode("manual")}
        >
          Type it in
        </button>
      </div>

      {mode === "link" ? (
        <div id="panel-link" role="tabpanel" aria-labelledby="tab-link">
          <LinkMode providers={providers} />
        </div>
      ) : (
        <div id="panel-manual" role="tabpanel" aria-labelledby="tab-manual">
          <ManualMode />
        </div>
      )}
    </section>
  );
}

function LinkMode({ providers }: { providers: string }) {
  const [lookup, lookupAction, looking] = useActionState<LookupState, FormData>(lookUpLink, {});
  const preview = lookup.preview;

  return (
    <>
      <form action={lookupAction} className="capture">
        <div className="field">
          <label htmlFor="link">Music link</label>
          <div className="row">
            <input
              id="link"
              name="link"
              type="text"
              inputMode="url"
              /**
               * Short on purpose. The guidance used to live here in full — "A
               * Spotify or Apple Music track, album or playlist" — and on a
               * phone the box is about 230px wide, so it was clipped to "A
               * Spotify or Apple Music trac". A placeholder is the one piece of
               * text in a form that cannot wrap, ellipsize or be scrolled to,
               * so anything a reader actually needs belongs in the hint below,
               * where it wraps and is readable whether or not the box is empty.
               */
              placeholder="Paste a link"
              defaultValue={lookup.link ?? ""}
              aria-describedby={lookup.error ? "lookup-error hint-link" : "hint-link"}
              required
            />
            <button type="submit" disabled={looking}>
              {looking ? "Looking…" : "Look up"}
            </button>
          </div>
          <p id="hint-link" className="note hint">
            A {providers} track, album or playlist.
          </p>
        </div>

        {lookup.error && (
          <p id="lookup-error" role="alert" className="error">
            {lookup.error}
          </p>
        )}
      </form>

      {/* Keyed on the identifier so pasting a second link resets the note box
          instead of carrying the previous track's half-written text over. */}
      {preview?.kind === "track" && (
        <TrackFound key={preview.providerId} preview={preview} />
      )}
      {preview?.kind === "collection" && (
        <CollectionFound
          key={preview.providerId}
          preview={preview}
          link={lookup.link ?? ""}
        />
      )}
    </>
  );
}

function TrackFound({ preview }: { preview: TrackPreview }) {
  const [state, action, saving] = useActionState<SaveState, FormData>(saveNoteForTrack, {});

  if (state.saved) {
    return (
      <p role="status" className="success">
        Saved your note on <strong>{preview.title}</strong>. It&rsquo;s below, and private.
      </p>
    );
  }

  return (
    <form action={action} className="found">
      <input type="hidden" name="provider" value={preview.provider} />
      <input type="hidden" name="providerId" value={preview.providerId} />

      <div className="found-head">
        <CoverArt url={preview.artwork.url} size={96} />
        <div className="found-meta">
          <p className="eyebrow">Track</p>
          <strong className="found-title">{preview.title}</strong>
          <div className="note">{preview.artistDisplay}</div>
          {preview.albumTitle && <div className="note">{preview.albumTitle}</div>}
        </div>
      </div>

      <div className="field">
        <label htmlFor="body">Your note</label>
        <textarea
          id="body"
          name="body"
          rows={4}
          placeholder="What do you want to remember about this track?"
          defaultValue={state.body ?? ""}
          autoFocus
          required
        />
      </div>

      {state.error && (
        <p role="alert" className="error">
          {state.error}
        </p>
      )}

      <button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save note"}
      </button>
    </form>
  );
}

function CollectionFound({ preview, link }: { preview: CollectionPreview; link: string }) {
  return (
    <form action={createCollectionFromPreview} className="found">
      <input type="hidden" name="link" value={link} />
      <input type="hidden" name="provider" value={preview.provider} />

      <div className="found-head">
        <CoverArt url={preview.artwork.url} size={128} />
        <div className="found-meta">
          <p className="eyebrow">{preview.collectionKind}</p>
          <strong className="found-title">{preview.name}</strong>
          {preview.byline && <div className="note">{preview.byline}</div>}
          <div className="note">
            {preview.trackCount} track{preview.trackCount === 1 ? "" : "s"}
            {preview.truncated && " (first page)"}
          </div>
        </div>
      </div>

      {/* Deliberately no note box. A note attaches to a track, and the place to
          write about a whole collection — or about one track inside it — is the
          collection's own page, which this button goes straight to. */}
      <p className="note">
        Adding this brings its tracks in as a snapshot. You can then write about the{" "}
        {preview.collectionKind} as a whole, and about any track inside it.
      </p>

      <button type="submit">Add this {preview.collectionKind}</button>
    </form>
  );
}

function ManualMode() {
  const [state, action, saving] = useActionState<SaveState, FormData>(saveManualNote, {});

  return (
    <form action={action} className="capture">
      <p className="note">
        For music no streaming service has — a demo, a bootleg, a live recording, an mp3 a
        friend sent. These stay yours alone and never join the shared catalog.
      </p>

      <div className="pair">
        <div className="field">
          <label htmlFor="title">Track title</label>
          <input id="title" name="title" defaultValue={state.values?.title ?? ""} required />
        </div>
        <div className="field">
          <label htmlFor="artistDisplay">Artist</label>
          <input
            id="artistDisplay"
            name="artistDisplay"
            defaultValue={state.values?.artistDisplay ?? ""}
            required
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="manual-body">Your note</label>
        <textarea
          id="manual-body"
          name="body"
          rows={4}
          placeholder="What do you want to remember about it?"
          defaultValue={state.body ?? ""}
          required
        />
      </div>

      {state.saved && (
        <p role="status" className="success">
          Saved. Your note is below.
        </p>
      )}

      {state.error && (
        <p role="alert" className="error">
          {state.error}
        </p>
      )}

      <button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save note"}
      </button>
    </form>
  );
}
