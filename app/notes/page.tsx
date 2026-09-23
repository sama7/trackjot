import Link from "next/link";
import { linkProviderNames } from "@/lib/music/link-providers";
import { requireOnboardedUser } from "@/lib/auth";
import {
  browseNotes,
  defaultDirectionFor,
  hasFilters,
  isSortKey,
  type SortDirection,
  type SortKey,
} from "@/lib/notes/browse";
import { toNoteRow } from "@/lib/notes/list";
import { DEFAULT_TIME_ZONE, dayBoundsInZone } from "@/lib/format-date";
import { searchNoteRows } from "@/lib/notes/search";
import { listTags } from "@/lib/notes/tags";
import { listPlaces } from "@/lib/notes/places";
import { PAGE_SIZE, countNotes, resolveLimit } from "@/lib/notes/browse";
import {
  lastfmAuthConfigured,
  lastfmConfigured,
} from "@/lib/music/lastfm/client";
import { BrowseBar } from "./browse-bar";
import { LastfmPrompt, Scrobbles } from "./scrobbles";
import { Panel } from "@/components/panel";
import { CaptureForm } from "./capture-form";
import { NoteRow } from "./note-row";
import { TagBar } from "./tag-bar";

export const dynamic = "force-dynamic";

// Renders as "Your notes · TrackJot" through the template in app/layout.tsx.
export const metadata = { title: "Your notes" };

/**
 * The notes page, with search.
 *
 * Search is a plain GET form rather than a client component. The query lands in
 * the URL, which means a search is linkable, survives a reload, and works with
 * the back button — all of which a `useState` box would have thrown away for no
 * gain at this size. It also keeps the query owner-scoped on the server with no
 * client round trip that could be pointed at someone else's notes.
 */
export default async function NotesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [params, user] = await Promise.all([searchParams, requireOnboardedUser("/notes")]);
  const query = (params.q ?? "").trim();
  const tagFilter = (params.tag ?? "").trim();
  const recordingFilter = (params.recording ?? "").trim();

  const importError = params.importError;

  /**
   * How many notes this view shows.
   *
   * The list stopped dead at 100 and search at 50, with nothing saying so and
   * no way past it — which for a personal archive means the older half of it
   * quietly stops existing. A `limit` in the URL keeps the view linkable and
   * survivable across a reload, exactly like the sort and the filters, and
   * "Show more" is a plain link rather than an infinite scroll that cannot be
   * bookmarked or shared. Clamped, because it comes from a query string.
   */
  const limit = resolveLimit(params.limit);

  // The sort key comes off the URL, so it is checked against the allowlist
  // rather than cast — a query string must never choose an ordering expression.
  const sort: SortKey = isSortKey(params.sort ?? "")
    ? (params.sort as SortKey)
    : "recent";
  const requestedDirection: SortDirection | undefined =
    params.dir === "asc" || params.dir === "desc" ? params.dir : undefined;
  // Names read A→Z; dates read newest first. Each sort brings its own sensible
  // default so the user picks a field, not a field and a direction. The rule
  // lives in one place so the control's wording and the query cannot drift.
  const direction: SortDirection =
    requestedDirection ?? defaultDirectionFor(sort);

  const filters = {
    track: (params.track ?? "").trim(),
    artist: (params.artist ?? "").trim(),
    album: (params.album ?? "").trim(),
    place: (params.place ?? "").trim(),
    from: (params.from ?? "").trim(),
    to: (params.to ?? "").trim(),
  };
  const activeFilters =
    Object.values(filters).filter(Boolean).length + (tagFilter ? 1 : 0);

  const zone = user.timeZone ?? DEFAULT_TIME_ZONE;
  const fromBounds = filters.from ? dayBoundsInZone(filters.from, zone) : null;
  const toBounds = filters.to ? dayBoundsInZone(filters.to, zone) : null;

  // Every path is owner-scoped in the query itself, never filtered afterwards.
  const results = query
    ? await searchNoteRows(user.id, query, limit + 1)
    : null;
  const [notes, tags, places, total] = await Promise.all([
    query
      ? Promise.resolve([])
      : browseNotes(user.id, {
          tag: tagFilter || undefined,
          track: filters.track || undefined,
          artist: filters.artist || undefined,
          album: filters.album || undefined,
          place: filters.place || undefined,
          recording: recordingFilter || undefined,
          /**
           * Bounds built in the reader's own zone, not in UTC.
           *
           * Pasting `T00:00:00Z` onto a date input's value made the filter
           * disagree with the page it was filtering: a listen at 11pm on the
           * 8th in New York is 03:00 on the 9th in UTC, so "heard until the
           * 8th" excluded a row displayed, correctly, as the 8th.
           */
          from: fromBounds?.start,
          to: toBounds?.end,
          sort,
          direction,
          // One extra, so the page can tell "exactly a full page" from
          // "there is more" without a second count query.
          limit: limit + 1,
        }),
    listTags(user.id),
    listPlaces(user.id),
    query
      ? Promise.resolve(0)
      : countNotes(user.id, {
          tag: tagFilter || undefined,
          track: filters.track || undefined,
          artist: filters.artist || undefined,
          album: filters.album || undefined,
          place: filters.place || undefined,
          recording: recordingFilter || undefined,
          from: fromBounds?.start,
          to: toBounds?.end,
        }),
  ]);

  const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3100";
  const tagNames = tags.map((t) => t.name);
  const placeNames = places.map((p) => p.label);
  const filtered =
    hasFilters({
      tag: tagFilter,
      track: filters.track,
      artist: filters.artist,
      album: filters.album,
      place: filters.place,
    }) || Boolean(filters.from || filters.to || recordingFilter);

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Your notes</h1>
          <p className="lede">
            Private by default. Nothing is shared until you say so.
          </p>
        </div>
      </header>

      {/* A failed collection import redirects here rather than swallowing the
          reason, so the message has to survive the redirect as a query param. */}
      {importError && (
        <p role="alert" className="error">
          {importError}
        </p>
      )}

      {/*
        The listening strip and the offer to connect one are both gated on the
        server having a Last.fm API key: the integration is feature-flagged, so
        a deployment without one never mentions it. Neither blocks this page —
        `Scrobbles` fetches itself after render.
      */}
      {lastfmConfigured() && user.lastfmUsername && (
        <Panel
          title="Recently played"
          summaryNote={`from ${user.lastfmUsername} on Last.fm`}
          storageKey="scrobbles"
        >
          <Scrobbles username={user.lastfmUsername} />
        </Panel>
      )}
      {/*
        Gated on the *auth* flag, not merely the key: connecting is the only
        thing this prompt offers, so a server that cannot complete an approval
        must not invite one and then dead-end.
      */}
      {lastfmAuthConfigured() &&
        !user.lastfmUsername &&
        !user.lastfmPromptDismissedAt && <LastfmPrompt />}

      {/*
        Closed by default, and the only panel that is.
        
        Writing a note starts with having something to write about — a link you
        copied, or a play in the strip above. Left open, the form put three
        fields and a mode switcher between the reader and their own archive on
        every single visit, which is the wrong default for a page people mostly
        come to *read*.
      */}
      <Panel
        title="Add a note"
        summaryNote="paste a link, or type it in"
        storageKey="capture"
        defaultOpen={false}
      >
        <CaptureForm providers={linkProviderNames()} />
      </Panel>

      {/*
        The anchor tag and place links jump to, so filtering the list scrolls to
        the list rather than back to the top of the page. `scroll-margin-top`
        keeps the heading clear of the sticky header.
      */}
      <section id="notes" className="notes-section">
        <BrowseBar
          q={query}
          sort={sort}
          direction={direction}
          filters={filters}
          active={activeFilters}
        />

        {!query && <TagBar tags={tags} active={tagFilter} />}

        {results ? (
          <>
            <h2>
              {results.length === 0
                ? `Nothing matches “${query}”`
                : `${Math.min(results.length, limit)}${
                    results.length > limit ? "+" : ""
                  } match${results.length === 1 ? "" : "es"} for “${query}”`}
            </h2>
            {results.length === 0 ? (
              <p className="note">
                Search covers what you wrote and the track and artist it was
                about. Try fewer words, or{" "}
                <Link href="/notes#notes">see everything</Link>.
              </p>
            ) : (
              <>
                {/* The same row the browse list renders, so a note you found is a
                  note you can edit, tag, date, place and share — rather than a
                  read-only card that told you it existed and stopped there. */}
                <ul className="notes">
                  {results.slice(0, limit).map((note) => (
                    <NoteRow
                      key={note.id}
                      note={toNoteRow(note)}
                      baseUrl={baseUrl}
                      allTags={tagNames}
                      allPlaces={placeNames}
                    />
                  ))}
                </ul>
                {results.length > limit && (
                  <ShowMore params={params} limit={limit} />
                )}
              </>
            )}
          </>
        ) : (
          <>
            <h2>
              {notes.length === 0
                ? tagFilter
                  ? `Nothing tagged “${tagFilter}”`
                  : filtered
                    ? "Nothing matches those filters"
                    : "Nothing yet"
                : `${total} note${total === 1 ? "" : "s"}${
                    tagFilter ? ` tagged “${tagFilter}”` : ""
                  }`}
            </h2>

            {notes.length === 0 ? (
              <p className="note">
                {filtered ? (
                  <>
                    Try widening them, or{" "}
                    <Link href="/notes#notes">see everything</Link>.
                  </>
                ) : (
                  <>
                    Paste a {linkProviderNames()} link above and write the
                    thing you want to remember about it.
                  </>
                )}
              </p>
            ) : (
              <>
                <ul className="notes">
                  {notes.slice(0, limit).map((note) => (
                    <NoteRow
                      key={note.id}
                      note={toNoteRow(note)}
                      baseUrl={baseUrl}
                      allTags={tagNames}
                      allPlaces={placeNames}
                    />
                  ))}
                </ul>
                {/* The exact count decides this, so the link cannot offer more
                  than exists — which is how "Show 50 more notes" came to sit
                  under an archive of six. */}
                {total > limit && (
                  <ShowMore
                    params={params}
                    limit={limit}
                    remaining={total - limit}
                  />
                )}
              </>
            )}
          </>
        )}
      </section>
    </main>
  );
}

/**
 * Another page, as a link.
 *
 * A link rather than a button because it keeps the view addressable: the URL
 * still describes exactly what is on screen, so a reload, the back button and a
 * shared link all behave. Infinite scroll would trade all three for a scrollbar
 * that never ends.
 */
function ShowMore({
  params,
  limit,
  remaining,
}: {
  params: Record<string, string | undefined>;
  limit: number;
  /** Exact, where it is known, so the label never promises what is not there. */
  remaining?: number;
}) {
  const step =
    remaining === undefined ? PAGE_SIZE : Math.min(remaining, PAGE_SIZE);

  const next = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value && key !== "limit") next.set(key, value);
  }
  next.set("limit", String(limit + PAGE_SIZE));

  return (
    <p className="note show-more">
      <Link href={`/notes?${next.toString()}`}>
        Show {step} more{step === 1 ? " note" : ""}
      </Link>
    </p>
  );
}
