import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NOTE_LIST_INCLUDE, type NoteWithSubject } from "@/lib/notes/list";
import { normalizeTagName } from "@/lib/notes/tags";

/**
 * Browsing your own notes: sorting, and filtering by the things a note is
 * actually about.
 *
 * The page previously offered "everything, newest first" and a tag filter, so
 * finding a note meant remembering your own wording well enough for full-text
 * search. People do not think that way about their own archive — they think
 * "that Nusrat one", "the ones from the Toronto trip", "everything off IGOR".
 *
 * Two rules hold throughout:
 *
 *   1. **Owner scope is in the WHERE clause, never a filter afterwards.** Every
 *      branch below composes onto `{ ownerId }`, so a bug in a filter can return
 *      the wrong subset of *your* notes and can never reach anyone else's.
 *   2. **Sorting is on an allowlist.** The sort key comes from a query string;
 *      mapping it through a fixed table rather than interpolating it keeps a URL
 *      from choosing arbitrary SQL.
 */

/**
 * `kind` is what the direction control reads to describe itself.
 *
 * Offering "Z → A / newest first" next to a sort of "Recently written" asked
 * the reader to work out which half of the label applied to them, and half of
 * it was always wrong. A sort by a date and a sort by a name are not the same
 * question, so they do not get the same words.
 */
export const SORT_OPTIONS = [
  { value: "recent", label: "Recently written", kind: "time" },
  { value: "experienced", label: "When you heard it", kind: "time" },
  { value: "track", label: "Track name", kind: "alpha" },
  { value: "artist", label: "Artist name", kind: "alpha" },
  { value: "album", label: "Album name", kind: "alpha" },
] as const;

export type SortKey = (typeof SORT_OPTIONS)[number]["value"];
export type SortDirection = "asc" | "desc";
type SortKind = (typeof SORT_OPTIONS)[number]["kind"];

export function isSortKey(value: string): value is SortKey {
  return SORT_OPTIONS.some((o) => o.value === value);
}

function kindOf(sort: SortKey): SortKind {
  return SORT_OPTIONS.find((o) => o.value === sort)?.kind ?? "time";
}

/**
 * Which way round a sort naturally runs.
 *
 * Names read A→Z and dates read newest-first, so choosing a field is enough on
 * its own — nobody should have to set two controls to express one intent. This
 * is the single definition: the page derives its fallback from it, the browse
 * query derives its default from it, and the control resets to it when the
 * field changes.
 */
export function defaultDirectionFor(sort: SortKey): SortDirection {
  return kindOf(sort) === "time" ? "desc" : "asc";
}

const DIRECTION_LABELS: Record<SortKind, Record<SortDirection, string>> = {
  time: { desc: "Newest first", asc: "Oldest first" },
  alpha: { desc: "Z → A", asc: "A → Z" },
};

/** The direction choices, worded for the field currently being sorted on. */
export function directionOptions(
  sort: SortKey,
): Array<{ value: SortDirection; label: string }> {
  const labels = DIRECTION_LABELS[kindOf(sort)];
  return [
    { value: "desc", label: labels.desc },
    { value: "asc", label: labels.asc },
  ];
}

/**
 * Ordering, as Prisma's `orderBy`.
 *
 * Sorting by track, artist or album orders on the *recording*, which is why
 * these are relation orderings rather than columns on `notes`. Prisma only
 * accepts a plain direction through a relation, so a note about a collection —
 * which has no recording — falls wherever PostgreSQL puts nulls. That is
 * acceptable for a handful of rows and not worth a raw query to control.
 * `experiencedAt` is a scalar, so it can say `nulls: "last"` and does: an
 * undated note is not "the oldest", it is undated.
 *
 * The display override is deliberately NOT part of the sort. It would need a
 * `COALESCE` across a relation that Prisma cannot express in `orderBy`, and the
 * override exists to correct a *display*, not to re-file the note.
 */
function orderFor(sort: SortKey, direction: SortDirection): Prisma.NoteOrderByWithRelationInput[] {
  switch (sort) {
    case "track":
      return [{ recording: { title: direction } }, { createdAt: "desc" }];
    case "artist":
      return [{ recording: { artistDisplay: direction } }, { createdAt: "desc" }];
    case "album":
      return [{ recording: { album: { title: direction } } }, { createdAt: "desc" }];
    case "experienced":
      return [{ experiencedAt: { sort: direction, nulls: "last" } }, { createdAt: "desc" }];
    case "recent":
    default:
      return [{ updatedAt: direction }];
  }
}

export interface BrowseFilters {
  tag?: string;
  /** Substring, case-insensitive. Separate fields so "IGOR" finds the album. */
  track?: string;
  artist?: string;
  album?: string;
  place?: string;
  /** Bounds on when the listening happened, not on when the note was written. */
  from?: Date;
  to?: Date;
  /**
   * Every note about one recording — what "View note" in the listening strip
   * opens. Owner scope still comes from `whereFor`, so a recording id from a URL
   * can only ever narrow *your* notes.
   */
  recording?: string;
}

export interface BrowseOptions extends BrowseFilters {
  sort?: SortKey;
  direction?: SortDirection;
  limit?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A screenful and a bit, for both browsing and searching. */
export const PAGE_SIZE = 50;

/**
 * How many notes a view should show, from an untrusted query string.
 *
 * **`Number("")` is `0`, not `NaN`**, and that one fact shipped a bug: the page
 * read `Number(params.limit ?? "")` and then asked `Number.isFinite`, which is
 * perfectly true of zero, so an absent parameter clamped to 1. Every view
 * showed a single note under a heading reading "1+ notes" with "Show 50 more"
 * beneath it, on an archive of six.
 *
 * Presence is therefore tested before value, and anything that is not a usable
 * number falls back to the page size rather than to whatever `Number` made of
 * it. Clamped at the top because this comes from a URL.
 */
export function resolveLimit(raw: string | undefined): number {
  if (!raw) return PAGE_SIZE;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return PAGE_SIZE;
  return Math.min(Math.trunc(value), 500);
}

/** True when any filter beyond the default listing is in play. */
export function hasFilters(filters: BrowseFilters): boolean {
  return Object.values(filters).some((v) => v !== undefined && v !== "");
}

/**
 * The WHERE clause, built once and shared by the listing and its count.
 *
 * Two queries that filter "the same way" by having the same code typed twice
 * drift, and the first symptom is a heading that disagrees with the list under
 * it. Owner scope is composed in here, so no caller can forget it.
 */
function whereFor(ownerId: string, options: BrowseFilters): Prisma.NoteWhereInput {
  const contains = (value: string | undefined) =>
    value?.trim() ? { contains: value.trim(), mode: Prisma.QueryMode.insensitive } : undefined;

  const recordingFilter: Prisma.RecordingWhereInput = {};
  if (contains(options.track)) recordingFilter.title = contains(options.track);
  if (contains(options.artist)) recordingFilter.artistDisplay = contains(options.artist);
  if (contains(options.album)) {
    /**
     * An album match has to consider both places the name can live: the linked
     * `albums` row when the track came from a provider with an album id, and the
     * denormalized `release_title` when it did not. Checking only the relation
     * would silently miss every manually entered note.
     */
    recordingFilter.OR = [
      { album: { title: contains(options.album) } },
      { releaseTitle: contains(options.album) },
    ];
  }

  const where: Prisma.NoteWhereInput = { ownerId };

  if (Object.keys(recordingFilter).length > 0) where.recording = recordingFilter;

  const tag = options.tag ? normalizeTagName(options.tag) : "";
  if (tag) where.tags = { some: { tag: { ownerId, name: tag } } };

  if (contains(options.place)) where.placeLabel = contains(options.place);

  // Checked for shape because it arrives in a URL and the column is a uuid:
  // anything else would be a query error rather than an empty result.
  if (options.recording && UUID.test(options.recording)) where.recordingId = options.recording;

  if (options.from || options.to) {
    where.experiencedAt = {
      ...(options.from ? { gte: options.from } : {}),
      ...(options.to ? { lte: options.to } : {}),
    };
  }

  return where;
}

export async function browseNotes(
  ownerId: string,
  options: BrowseOptions = {},
): Promise<NoteWithSubject[]> {
  const { sort = "recent", direction = defaultDirectionFor(sort), limit = 100 } = options;

  return prisma.note.findMany({
    where: whereFor(ownerId, options),
    orderBy: orderFor(sort, direction),
    include: NOTE_LIST_INCLUDE,
    take: Math.min(Math.max(limit, 1), 500),
  });
}

/**
 * How many notes match, exactly.
 *
 * The heading used to be inferred from the page: fetch one more row than asked
 * for, and say "50+" when it came back. That was cheap and it read badly — and
 * when a paging bug made the page size 1, it read as "1+ notes" above a single
 * note with "Show 50 more" underneath, on an archive of six. An indexed COUNT
 * over one person's notes is not worth being vague to avoid.
 */
export async function countNotes(ownerId: string, filters: BrowseFilters = {}): Promise<number> {
  return prisma.note.count({ where: whereFor(ownerId, filters) });
}
