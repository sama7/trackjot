"use client";

import { useState } from "react";
import { CoverArt } from "@/components/cover-art";
import { TrackNote } from "./track-note";

/**
 * A collection's tracks, on a desktop and on a phone.
 *
 * Three things went wrong in the first version and all three came from the same
 * mistake — treating the phone layout as "the desktop layout with things
 * hidden":
 *
 *   1. **Notes were hidden behind the sheet.** A note you have written is the
 *      most valuable thing on the row and the reason you opened the collection;
 *      it now renders under its track at every width. The sheet holds the
 *      *controls*, not the content.
 *   2. **Sheets stacked.** Each row owned its own open flag, so tapping a
 *      second one layered it over the first and you closed them in reverse.
 *      Open state lives here now — one list, one open row, by construction.
 *   3. **The sheet was cramped.** It shows the cover large, since a phone has
 *      the width for it once the row is not competing for the space.
 */

export interface TrackRow {
  id: string;
  position: number;
  title: string;
  artists: string;
  albumTitle: string | null;
  artworkThumbUrl: string | null;
  artworkUrl: string | null;
  providerUrl: string | null;
  providerName: string | null;
  note: { id: string; body: string } | null;
}

export function TrackList({
  collectionId,
  tracks,
}: {
  collectionId: string;
  tracks: TrackRow[];
}) {
  // One id, not a set: a second sheet replaces the first rather than covering it.
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <ol className="tracklist">
      {tracks.map((track) => {
        const open = openId === track.id;
        return (
          <li key={track.id} className={`track${open ? " sheet-open" : ""}`}>
            <div className="track-line">
              <span className="track-num note">{track.position}</span>
              <CoverArt
                url={track.artworkThumbUrl}
                fullUrl={track.artworkUrl}
                size={48}
                title={track.title}
              />

              <div className="track-main">
                <div className="track-title">
                  {track.providerUrl ? (
                    <a href={track.providerUrl} target="_blank" rel="noopener noreferrer">
                      {track.title}
                    </a>
                  ) : (
                    track.title
                  )}
                </div>
                {/* Linked entities where we have them, the raw credit where we
                    do not. The display string is never reconstructed from the
                    entities, so an artist we failed to link is still shown. */}
                <div className="note">{track.artists}</div>
              </div>

              {track.albumTitle && <div className="track-album note">{track.albumTitle}</div>}

              <button
                type="button"
                className="track-more"
                aria-expanded={open}
                aria-label={`Options for ${track.title}`}
                onClick={() => setOpenId(open ? null : track.id)}
              >
                {/* Drawn rather than typed. The character "⋯" is centred by
                    whatever font happens to resolve, and in the system stack it
                    sat low and slightly left inside its tap target; three
                    circles are placed by us and land the same way everywhere. */}
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <circle cx="5" cy="12" r="1.9" fill="currentColor" />
                  <circle cx="12" cy="12" r="1.9" fill="currentColor" />
                  <circle cx="19" cy="12" r="1.9" fill="currentColor" />
                </svg>
              </button>
            </div>

            {/*
              Something to tap that is not the sheet.
              
              The sheet is `position: fixed` over the page, and the page behind
              it stayed live — so the only way out was the Close button, and
              tapping the dimmed area above did nothing. Every other dismissible
              surface here closes that way, including the cover art, and a
              bottom sheet is the one people are most likely to try it on.
              
              Rendered only for the open row, so there is exactly one.
            */}
            {open && (
              <button
                type="button"
                className="sheet-backdrop"
                aria-label="Close options"
                onClick={() => setOpenId(null)}
              />
            )}

            {/* The note itself, at every width. */}
            {track.note && !open && <p className="track-note-body">{track.note.body}</p>}

            <div className="track-details">
              <div className="sheet-head">
                <CoverArt
                  url={track.artworkUrl ?? track.artworkThumbUrl}
                  fullUrl={track.artworkUrl}
                  size={200}
                  title={track.title}
                  className="sheet-cover"
                />
                <div>
                  <strong>{track.title}</strong>
                  <div className="note">{track.artists}</div>
                  {track.albumTitle && <div className="note">{track.albumTitle}</div>}
                  {track.providerUrl && track.providerName && (
                    <p className="note">
                      <a href={track.providerUrl} target="_blank" rel="noopener noreferrer">
                        Open in {track.providerName}
                      </a>
                    </p>
                  )}
                </div>
              </div>

              <TrackNote
                collectionItemId={track.id}
                collectionId={collectionId}
                trackTitle={track.title}
                note={track.note}
              />

              <button
                type="button"
                className="sheet-close linkish"
                onClick={() => setOpenId(null)}
              >
                Done
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
