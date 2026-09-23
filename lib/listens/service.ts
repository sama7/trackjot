import { DatePrecision, ListenSource, Provider, type Listen } from "@prisma/client";
import { prisma } from "@/lib/db";
import { normalizedKey } from "@/lib/music/normalize";
import {
  fetchRecentTracks,
  lastfmAuthConfigured,
  type RecentTrack,
} from "@/lib/music/lastfm/client";
import { createUserAuthoredRecording, resolveByProviderId } from "@/lib/music/resolve-recording";
import { captureFromProviderRef } from "@/lib/music/capture-track";
import { findTrackCandidates, type TrackCandidate } from "@/lib/music/match-track";
import { fetchTrackInfo } from "@/lib/music/lastfm/client";
import { createNote } from "@/lib/notes/service";

/**
 * Listening history as a source, and the one judgement call it forces.
 *
 * ## What a scrobble is allowed to create
 *
 * The catalog rule is that **entities come from identifiers, never from names**
 * (AGENTS.md §3a), and Last.fm is explicitly not permitted to establish
 * recording identity. A scrobble arrives as three strings and, sometimes, a
 * MusicBrainz id. So it forks:
 *
 *   - **With a recording MBID** — MusicBrainz is a trusted `Provider`, so the
 *     play resolves through the ordinary `resolveByProviderId` path. It matches
 *     an existing recording if we already hold that id and creates a
 *     provider-anchored one otherwise, exactly as a pasted link would.
 *   - **Without one** — a `origin = user` recording, scoped to its creator and
 *     kept out of everyone else's resolution candidates. Two people scrobbling
 *     the same obscure song get two rows, and that is correct: a duplicate is
 *     cheap, a false merge is not.
 *
 * **The MBID is where the risk lives, and it is worth naming.** The id itself
 * comes from an authority; the claim that *this play* is *that recording* comes
 * from Last.fm's own matching, which is not perfect. That claim is therefore
 * also written to the listen row as provenance — so if Last.fm is ever found to
 * have mis-matched, every recording it influenced can be located and unwound.
 * The alternative, resolving by name, is the one thing the contract forbids
 * outright.
 *
 * ## What it never creates
 *
 * No artist rows, no album rows. Last.fm supplies those as names, and a name is
 * not an identifier. The album title is carried as `releaseTitle` — display
 * data, which is exactly what the schema says that column is for.
 */

/** A play, prepared for rendering. Flat, so the UI does no joining. */
export interface ListenView {
  sourceRef: string;
  trackName: string;
  artistName: string;
  albumName: string | null;
  playedAt: Date | null;
  url: string | null;
  /** True when Last.fm gave a MusicBrainz id, so the import can be anchored. */
  identified: boolean;
  /**
   * The recording this play resolved to, when it has been written about — so
   * "View note" can open exactly the notes about this track.
   */
  recordingId: string | null;
  /**
   * How many notes exist about this track.
   *
   * A count rather than a single "imported" flag: the strip used to answer
   * "have I written about this?" with a bare "Jotted" and no way in, and then
   * refused a second note about a song you had heard again. Hearing something
   * twice is two occasions, and each may deserve its own note.
   */
  noteCount: number;
}

const NOW_PLAYING_PREFIX = "nowplaying:";
/** How long a now-playing capture stays eligible to absorb its completed play. */
const RECONCILE_WINDOW_MS = 30 * 60 * 1000;

export class LastfmNotLinkedError extends Error {
  constructor() {
    super("No Last.fm account is linked.");
    this.name = "LastfmNotLinkedError";
  }
}

/**
 * Disconnect the account.
 *
 * Listens already recorded are **kept**, and so are the notes written from
 * them. Disconnecting a source is not a request to delete your own history —
 * the writing is yours, and it stopped being Last.fm's the moment you wrote it.
 *
 * The session key is cleared, which is the part that matters: a disconnected
 * account must leave no usable credential behind. Last.fm's own settings page
 * is where access is revoked on their side, and this is deliberately not
 * presented as doing that.
 */
export async function unlinkLastfm(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { lastfmUsername: null, lastfmSessionKey: null, lastfmLinkedAt: null },
  });
}

/**
 * Forget a session key that Last.fm has rejected.
 *
 * Keeping a revoked credential would mean every later read fails the same way
 * with no way for the user to tell why. Clearing it puts the connection back
 * into the state the UI knows how to explain: reconnect.
 */
export async function invalidateLastfmSession(userId: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { lastfmSessionKey: null } });
}

export async function dismissLastfmPrompt(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { lastfmPromptDismissedAt: new Date() },
  });
}

/** Normalized (artist, track), for spotting the same song reported twice. */
function playKey(artistName: string, trackName: string): string {
  return normalizedKey({ title: trackName, artistDisplay: artistName, durationMs: null });
}

/**
 * Read the recent feed and fold it into the listens ledger.
 *
 * Idempotent by `(owner, source, sourceRef)`: re-reading the same window
 * updates rather than duplicating a person's history. A now-playing track is
 * **not** persisted here — it is not yet a play Last.fm has reported — but it is
 * returned so the strip can offer the freshest moment of all.
 */
export async function syncRecentListens(
  userId: string,
  limit = 10,
  /**
   * Which page of history. 1 is what the strip shows and polls; anything
   * higher is the reader explicitly asking for earlier listening.
   *
   * Deliberately a page rather than a full import. The contract keeps whole
   * history out of scope, and it should stay out — but "the last ten plays" is
   * a capture aid, not a day, and someone who sits down in the evening should
   * not find the morning gone. One requested page at a time is the smallest
   * thing that fixes that.
   */
  page = 1,
): Promise<ListenView[]> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    // The session key is read here and nowhere else — it is a credential, and
    // this is the one place that legitimately needs it.
    select: { lastfmUsername: true, lastfmSessionKey: true },
  });
  if (!user.lastfmUsername) throw new LastfmNotLinkedError();

  /**
   * Signed as the connected account when a session key is held, which is what
   * lets this read a history the user has hidden from the public API — the
   * whole reason the approval flow exists. A profile that hides nothing still
   * reads fine without one.
   */
  const tracks = await fetchRecentTracks(
    user.lastfmUsername,
    limit,
    fetch,
    // Only when signing is actually possible. A deployment that holds stored
    // session keys but has lost the shared secret would otherwise fail every
    // read outright, where degrading to a public one still works for every
    // profile that hides nothing.
    lastfmAuthConfigured() ? user.lastfmSessionKey : null,
    page,
  );

  for (const track of tracks) {
    if (!track.playedAt) continue;
    await persistPlay(userId, track);
  }

  return viewFor(userId, tracks);
}

/**
 * Write one completed play, absorbing an earlier now-playing capture of it.
 *
 * Without the absorption step, jotting a song *while it played* and then having
 * Last.fm report the finished play would leave two rows for one listen — the
 * imported one and an orphan. Matching on normalized (artist, track) within a
 * short window collapses them, which keeps "how many times have I heard this"
 * answerable.
 */
async function persistPlay(userId: string, track: RecentTrack): Promise<void> {
  const playedAt = track.playedAt!;

  const pending = await prisma.listen.findFirst({
    where: {
      ownerId: userId,
      source: ListenSource.lastfm,
      sourceRef: { startsWith: NOW_PLAYING_PREFIX },
      playedAt: { gte: new Date(playedAt.getTime() - RECONCILE_WINDOW_MS) },
    },
    orderBy: { playedAt: "desc" },
  });

  if (
    pending &&
    playKey(pending.artistName, pending.trackName) === playKey(track.artistName, track.trackName)
  ) {
    /**
     * Only if that completed play is not already recorded.
     *
     * Renaming the pending row onto `track.sourceRef` collides with the unique
     * `(owner, source, source_ref)` when a row for that scrobble already
     * exists — which happens whenever a sync reports the same completed play
     * twice, or the same song was heard earlier and is being heard again.
     * Where the destination exists, the pending row has nothing to fold into
     * it and is simply dropped; where it does not, the rename is safe.
     *
     * A collision is resolved in favour of **keeping the plays separate**,
     * which is the rule the whole listens model is built on: two hearings of
     * one song are two events, and merging them silently is the one outcome
     * that destroys information.
     */
    const alreadyRecorded = await prisma.listen.findUnique({
      where: {
        ownerId_source_sourceRef: {
          ownerId: userId,
          source: ListenSource.lastfm,
          sourceRef: track.sourceRef,
        },
      },
      select: { id: true },
    });

    if (!alreadyRecorded) {
      await prisma.listen.update({
        where: { id: pending.id },
        data: { sourceRef: track.sourceRef, playedAt, sourceUrl: track.url },
      });
      return;
    }
    // Fall through and upsert the real row; the pending one keeps its own
    // identity rather than being destroyed, since it may carry a jot.
  }

  await prisma.listen.upsert({
    where: {
      ownerId_source_sourceRef: {
        ownerId: userId,
        source: ListenSource.lastfm,
        sourceRef: track.sourceRef,
      },
    },
    create: {
      ownerId: userId,
      source: ListenSource.lastfm,
      sourceRef: track.sourceRef,
      sourceUrl: track.url,
      playedAt,
      trackName: track.trackName,
      artistName: track.artistName,
      albumName: track.albumName,
      recordingMbid: track.recordingMbid,
      artistMbid: track.artistMbid,
      albumMbid: track.albumMbid,
    },
    // A re-read may carry mbids a first read lacked; nothing else changes.
    update: {
      recordingMbid: track.recordingMbid,
      artistMbid: track.artistMbid,
      albumMbid: track.albumMbid,
      sourceUrl: track.url,
    },
  });
}

/** Merge the live feed with what we know about it, newest first. */
async function viewFor(userId: string, tracks: RecentTrack[]): Promise<ListenView[]> {
  const stored = await prisma.listen.findMany({
    where: {
      ownerId: userId,
      source: ListenSource.lastfm,
      sourceRef: { in: tracks.map((t) => t.sourceRef) },
    },
    select: { sourceRef: true, recordingId: true },
  });

  /**
   * Only the ids that exist. An empty-string placeholder for "no recording"
   * reaches the driver as an invalid uuid and fails the whole query — the
   * column is typed, so a sentinel has to be an absent clause rather than a
   * fake value.
   */
  const recordingIds = stored
    .map((s) => s.recordingId)
    .filter((id): id is string => id !== null);

  const counts =
    recordingIds.length > 0
      ? await prisma.note.groupBy({
          by: ["recordingId"],
          where: { ownerId: userId, recordingId: { in: recordingIds } },
          _count: { _all: true },
        })
      : [];
  const notesByRecording = new Map(counts.map((c) => [c.recordingId, c._count._all]));
  const recordingByRef = new Map(stored.map((s) => [s.sourceRef, s.recordingId]));

  return tracks.map((track) => {
    const recordingId = recordingByRef.get(track.sourceRef) ?? null;
    return {
      sourceRef: track.sourceRef,
      trackName: track.trackName,
      artistName: track.artistName,
      albumName: track.albumName,
      playedAt: track.playedAt,
      url: track.url,
      identified: Boolean(track.recordingMbid),
      recordingId,
      noteCount: recordingId ? (notesByRecording.get(recordingId) ?? 0) : 0,
    };
  });
}

/**
 * Offer provider matches for a play, so it need not stay nameless.
 *
 * Run when someone starts writing, never for the whole strip: it costs a
 * `track.getInfo` and two searches, and doing that for ten rows on every page
 * load would spend a great deal of somebody else's rate limit to answer a
 * question nobody asked.
 *
 * Last.fm's duration is what makes the suggestions defensible rather than
 * hopeful — it is frequently present even when the mbid is not, and it
 * separates an original from its extended mix decisively.
 */
export async function candidatesForListen(
  userId: string,
  input: { trackName: string; artistName: string },
): Promise<TrackCandidate[]> {
  const info = await fetchTrackInfo(input.artistName, input.trackName);
  return findTrackCandidates({
    title: input.trackName,
    artistName: input.artistName,
    durationMs: info.durationMs,
  });
}

/**
 * Turn one play into a recording and a private jot about it.
 *
 * The listening instant becomes the note's `experiencedAt` at `time`
 * precision — the reason the whole integration exists. A note written today
 * about a song heard on Tuesday is dated Tuesday.
 */
export async function importListen(
  userId: string,
  input: {
    sourceRef: string;
    body: string;
    track?: RecentTrack;
    /**
     * A provider match the user looked at and confirmed. Only the provider and
     * its id are honoured — everything else is re-read from the provider, so a
     * tampered field cannot inject a title, an album, or an artwork URL.
     */
    confirmed?: { provider: Provider; providerId: string } | null;
    /** Per-submission key, so a retried save produces one note, not two. */
    idempotencyKey?: string | null;
  },
): Promise<{ noteId: string }> {
  let listen = await prisma.listen.findUnique({
    where: {
      ownerId_source_sourceRef: {
        ownerId: userId,
        source: ListenSource.lastfm,
        sourceRef: input.sourceRef,
      },
    },
  });

  /**
   * A now-playing track has no persisted row, because it is not yet a play
   * Last.fm has reported. Capturing it writes one at this instant, which is
   * true: you are hearing it now. `persistPlay` later folds the completed
   * scrobble into this row rather than leaving an orphan beside it.
   */
  if (!listen && input.track && input.sourceRef.startsWith(NOW_PLAYING_PREFIX)) {
    listen = await prisma.listen.create({
      data: {
        ownerId: userId,
        source: ListenSource.lastfm,
        sourceRef: input.sourceRef,
        sourceUrl: input.track.url,
        playedAt: new Date(),
        trackName: input.track.trackName,
        artistName: input.track.artistName,
        albumName: input.track.albumName,
        recordingMbid: input.track.recordingMbid,
        artistMbid: input.track.artistMbid,
        albumMbid: input.track.albumMbid,
      },
    });
  }

  if (!listen) throw new LastfmNotLinkedError();

  const recordingId =
    listen.recordingId ?? (await resolveRecordingFor(userId, listen, input.confirmed)).id;

  /**
   * Both writes, or neither.
   *
   * This used to be two statements. A failure between them left a note written
   * and the listen still unimported, so the obvious thing to do next — press
   * Save again — wrote a *second* note about the same play. Together with the
   * idempotency key, one submission now produces exactly one note no matter how
   * many times it is retried or where it fails.
   */
  const note = await prisma.$transaction(async (tx) => {
    const created = await createNote(
      userId,
      {
        recordingId,
        body: input.body,
        experiencedAt: listen.playedAt,
        experiencedPrecision: DatePrecision.time,
        idempotencyKey: input.idempotencyKey ?? null,
      },
      tx,
    );

    await tx.listen.update({
      where: { id: listen.id },
      data: { recordingId, importedAt: new Date() },
    });

    return created;
  });

  return { noteId: note.id };
}

/** The fork described at the top of this file: identifier, or creator-scoped. */
async function resolveRecordingFor(
  userId: string,
  listen: Listen,
  confirmed?: { provider: Provider; providerId: string } | null,
) {
  /**
   * A match the user confirmed. Resolved through the ordinary capture path,
   * which **re-reads the track from the provider by id** — so the recording,
   * its artists, its album and its artwork all come from the provider rather
   * than from anything the browser sent. The confirmation supplies an
   * identifier; it does not supply facts.
   *
   * This is §3a.5's "identifier acquisition": a name search suggested it, a
   * person agreed, and what anchors the row is the provider's own id.
   */
  if (confirmed) {
    const capture = await captureFromProviderRef(confirmed.provider, confirmed.providerId);
    if (capture.ok) return capture.recording;
    // The provider could not confirm its own id; fall through rather than fail
    // the note. Somebody is mid-sentence.
  }

  if (listen.recordingMbid) {
    const resolved = await resolveByProviderId({
      provider: Provider.musicbrainz,
      providerId: listen.recordingMbid,
      title: listen.trackName,
      artistDisplay: listen.artistName,
    });
    // The album name is display data, never an entity — see the header.
    if (listen.albumName && !resolved.recording.releaseTitle) {
      await prisma.recording.update({
        where: { id: resolved.recording.id },
        data: { releaseTitle: listen.albumName },
      });
    }
    return resolved.recording;
  }

  const { recording } = await createUserAuthoredRecording({
    ownerId: userId,
    title: listen.trackName,
    artistDisplay: listen.artistName,
  });

  if (listen.albumName) {
    await prisma.recording.update({
      where: { id: recording.id },
      data: { releaseTitle: listen.albumName },
    });
  }
  return recording;
}
