"use client";

import { useState } from "react";
import Link from "next/link";
import {
  SORT_OPTIONS,
  defaultDirectionFor,
  directionOptions,
  type SortDirection,
  type SortKey,
} from "@/lib/notes/browse";

/**
 * Sorting and filtering, as a plain GET form.
 *
 * Everything lands in the URL rather than in component state, which is what
 * makes a view linkable, survivable across a reload, and correct with the back
 * button. It also keeps the query owner-scoped on the server with no client
 * round trip that could be pointed at somebody else's notes.
 *
 * The filter fields are collapsed until asked for. Most visits are "show me
 * what I wrote lately"; six inputs above that would be a form standing between
 * a person and their own archive.
 */
export function BrowseBar({
  q,
  sort,
  direction,
  filters,
  active,
}: {
  q: string;
  sort: SortKey;
  direction: SortDirection;
  filters: { track: string; artist: string; album: string; place: string; from: string; to: string };
  /** How many filters are in play, so a collapsed panel still says so. */
  active: number;
}) {
  const [open, setOpen] = useState(active > 0);
  /**
   * The two sort controls are one decision, so they are held together.
   *
   * The direction options were static — "A → Z / oldest first" and "Z → A /
   * newest first" — which meant that under a sort of "Recently written" the
   * reader was shown an alphabetical label for a chronological ordering and had
   * to discard the half that did not apply. The wording now comes from the
   * field being sorted on, and changing the field resets the direction to that
   * field's natural one, so picking "Track name" cannot leave "Newest first"
   * standing next to it.
   */
  const [sortKey, setSortKey] = useState<SortKey>(sort);
  const [dir, setDir] = useState<SortDirection>(direction);

  return (
    <form action="/notes" method="get" className="browse" role="search">
      <div className="browse-line">
        <label className="visually-hidden" htmlFor="q">
          Search your notes
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={q}
          placeholder="Search your notes"
        />
        <button type="submit">Search</button>
      </div>

      <div className="browse-line">
        <label htmlFor="sort" className="note">
          Sort
        </label>
        <select
          id="sort"
          name="sort"
          value={sortKey}
          onChange={(event) => {
            const next = event.target.value as SortKey;
            setSortKey(next);
            setDir(defaultDirectionFor(next));
          }}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <label htmlFor="dir" className="visually-hidden">
          Direction
        </label>
        <select
          id="dir"
          name="dir"
          value={dir}
          onChange={(event) => setDir(event.target.value as SortDirection)}
        >
          {directionOptions(sortKey).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <button type="button" className="linkish" onClick={() => setOpen((v) => !v)}>
          {open ? "Fewer filters" : active > 0 ? `Filters (${active})` : "More filters"}
        </button>

        {(active > 0 || q) && (
          /* `#notes` for the same reason the tag and place links carry it:
             clearing a filter should land on the list you are clearing it for,
             not scroll back past the listening strip to the top of the page. */
          <Link href="/notes#notes" className="note">
            Clear
          </Link>
        )}
      </div>

      {open && (
        <div className="browse-filters">
          <div className="field">
            <label htmlFor="track">Track</label>
            <input id="track" name="track" defaultValue={filters.track} />
          </div>
          <div className="field">
            <label htmlFor="artist">Artist</label>
            <input id="artist" name="artist" defaultValue={filters.artist} />
          </div>
          <div className="field">
            <label htmlFor="album">Album</label>
            <input id="album" name="album" defaultValue={filters.album} />
          </div>
          <div className="field">
            <label htmlFor="place">Place</label>
            <input id="place" name="place" defaultValue={filters.place} />
          </div>
          {/* Bounds on when you HEARD it, not on when the note was typed —
              which is the whole reason "experienced at" is a separate column. */}
          <div className="field">
            <label htmlFor="from">Heard from</label>
            <input id="from" name="from" type="date" defaultValue={filters.from} />
          </div>
          <div className="field">
            <label htmlFor="to">Heard until</label>
            <input id="to" name="to" type="date" defaultValue={filters.to} />
          </div>
          <button type="submit">Apply</button>
        </div>
      )}
    </form>
  );
}
