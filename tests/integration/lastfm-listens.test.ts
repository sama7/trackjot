import { DatePrecision, ListenSource, PrismaClient, Provider, RecordingOrigin } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LastfmNotLinkedError,
  importListen,
  invalidateLastfmSession,
  syncRecentListens,
  unlinkLastfm,
} from "@/lib/listens/service";
import { resetDatabase } from "./reset";

const prisma = new PrismaClient();

/**
 * Turning a listening history into notes, and the catalog rules that constrain
 * how much of it is allowed to become shared truth.
 *
 * The riskiest thing here is not the HTTP call — that is unit-tested against
 * recorded shapes — it is the resolution fork. Last.fm may not establish
 * recording identity (AGENTS.md), so a scrobble with a MusicBrainz id resolves
 * through the ordinary trusted-provider path while one without stays scoped to
 * its creator. Getting that backwards would quietly fill the shared catalog with
 * name-matched guesses, which is the one outcome the catalog policy exists to
 * prevent.
 */

const PLAYED_AT = new Date("2026-09-08T19:39:00.000Z");
const MBID = "b1e2c3d4-0000-4000-8000-0000000000aa";

function lastfmResponse(tracks: unknown[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ recenttracks: { track: tracks } }), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function play(overrides: Record<string, unknown> = {}) {
  return {
    name: "CN TOWER",
    mbid: "",
    url: "https://www.last.fm/music/PARTYNEXTDOOR/_/CN+TOWER",
    artist: { "#text": "PARTYNEXTDOOR", mbid: "" },
    album: { "#text": "$ome $exy $ongs 4 U", mbid: "" },
    date: { uts: String(Math.floor(PLAYED_AT.getTime() / 1000)) },
    ...overrides,
  };
}

async function makeUser(lastfmUsername: string | null = "samah-") {
  return prisma.user.create({
    data: { authSubject: `s_${crypto.randomUUID()}`, lastfmUsername },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
  vi.stubEnv("LASTFM_API_KEY", "test-key");
  vi.stubEnv("LASTFM_SHARED_SECRET", "s3cr3t");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

describe("disconnecting", () => {
  /**
   * Disconnecting a source is not a request to delete your own writing. The
   * opposite would make connecting it feel like a trap.
   */
  it("keeps listens and notes, and destroys the credential", async () => {
    const user = await prisma.user.create({
      data: {
        authSubject: `s_${crypto.randomUUID()}`,
        lastfmUsername: "samah-",
        lastfmSessionKey: "a-session-key",
      },
    });
    vi.stubGlobal("fetch", lastfmResponse([play()]));
    await syncRecentListens(user.id);
    await importListen(user.id, {
      sourceRef: (await prisma.listen.findFirstOrThrow({ where: { ownerId: user.id } })).sourceRef,
      body: "the city sounds under the intro",
    });

    await unlinkLastfm(user.id);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.lastfmUsername).toBeNull();
    // A disconnected account must leave no usable credential behind.
    expect(after.lastfmSessionKey).toBeNull();
    expect(await prisma.listen.count({ where: { ownerId: user.id } })).toBe(1);
    expect(await prisma.note.count({ where: { ownerId: user.id } })).toBe(1);
  });

  it("refuses to read a feed for a user who has connected none", async () => {
    const user = await makeUser(null);
    await expect(syncRecentListens(user.id)).rejects.toThrow(LastfmNotLinkedError);
  });

  it("forgets only the credential when Last.fm rejects it", async () => {
    const user = await prisma.user.create({
      data: {
        authSubject: `s_${crypto.randomUUID()}`,
        lastfmUsername: "samah-",
        lastfmSessionKey: "revoked",
      },
    });

    await invalidateLastfmSession(user.id);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.lastfmSessionKey).toBeNull();
    // The username stays, so the UI can say "reconnect" rather than "connect".
    expect(after.lastfmUsername).toBe("samah-");
  });
});

describe("reading as the connected account", () => {
  /**
   * The reason the approval flow exists: a profile that hides its listening
   * returns error 17 to a public read, and a signed read gets through.
   */
  it("signs the request when a session key is held", async () => {
    const user = await prisma.user.create({
      data: {
        authSubject: `s_${crypto.randomUUID()}`,
        lastfmUsername: "womenaresmarter",
        lastfmSessionKey: "the-session-key",
      },
    });

    let seen: URL | null = null;
    vi.stubGlobal("fetch", (async (url: URL) => {
      seen = url;
      return new Response(JSON.stringify({ recenttracks: { track: [play()] } }));
    }) as unknown as typeof fetch);

    await syncRecentListens(user.id);

    expect(seen!.searchParams.get("sk")).toBe("the-session-key");
    expect(seen!.searchParams.get("api_sig")).toMatch(/^[0-9a-f]{32}$/);
  });

  /**
   * A server holding session keys but missing the shared secret cannot sign
   * anything. Failing every read would be worse than reading publicly, which
   * still works for every profile that hides nothing.
   */
  it("falls back to a public read when signing is impossible", async () => {
    const user = await prisma.user.create({
      data: {
        authSubject: `s_${crypto.randomUUID()}`,
        lastfmUsername: "samah-",
        lastfmSessionKey: "unusable-without-a-secret",
      },
    });
    vi.stubEnv("LASTFM_SHARED_SECRET", "");

    let seen: URL | null = null;
    vi.stubGlobal("fetch", (async (url: URL) => {
      seen = url;
      return new Response(JSON.stringify({ recenttracks: { track: [play()] } }));
    }) as unknown as typeof fetch);

    await expect(syncRecentListens(user.id)).resolves.toHaveLength(1);
    expect(seen!.searchParams.get("sk")).toBeNull();
  });

  /**
   * A revoked key makes even a public profile fail while it is still stored.
   * Clearing it must leave the account in a state that works, not one that
   * errors until the next visit.
   */
  it("clears a rejected key, leaving the next read able to succeed publicly", async () => {
    const user = await prisma.user.create({
      data: {
        authSubject: `s_${crypto.randomUUID()}`,
        lastfmUsername: "samah-",
        lastfmSessionKey: "revoked-key",
      },
    });

    vi.stubGlobal("fetch", (async (url: URL) =>
      url.searchParams.get("sk")
        ? new Response(JSON.stringify({ error: 9, message: "Invalid session key" }), { status: 403 })
        : new Response(JSON.stringify({ recenttracks: { track: [play()] } }))) as unknown as typeof fetch);

    await expect(syncRecentListens(user.id)).rejects.toMatchObject({ reason: "bad-session" });
    await invalidateLastfmSession(user.id);

    // With the dead key gone, the very same feed reads publicly.
    await expect(syncRecentListens(user.id)).resolves.toHaveLength(1);
  });

  it("makes an ordinary public read when there is no session key", async () => {
    const user = await makeUser();
    let seen: URL | null = null;
    vi.stubGlobal("fetch", (async (url: URL) => {
      seen = url;
      return new Response(JSON.stringify({ recenttracks: { track: [play()] } }));
    }) as unknown as typeof fetch);

    await syncRecentListens(user.id);

    expect(seen!.searchParams.get("sk")).toBeNull();
    expect(seen!.searchParams.get("api_sig")).toBeNull();
  });
});

describe("syncing the recent feed", () => {
  it("records the play instant and the raw strings the source reported", async () => {
    const user = await makeUser();
    vi.stubGlobal("fetch", lastfmResponse([play({ mbid: MBID })]));

    await syncRecentListens(user.id);

    const listen = await prisma.listen.findFirstOrThrow({ where: { ownerId: user.id } });
    expect(listen.playedAt.toISOString()).toBe(PLAYED_AT.toISOString());
    expect(listen.trackName).toBe("CN TOWER");
    expect(listen.artistName).toBe("PARTYNEXTDOOR");
    expect(listen.albumName).toBe("$ome $exy $ongs 4 U");
    expect(listen.recordingMbid).toBe(MBID);
    expect(listen.source).toBe(ListenSource.lastfm);
  });

  /** Re-reading the same window must not duplicate a person's history. */
  it("is idempotent across repeated syncs", async () => {
    const user = await makeUser();
    vi.stubGlobal("fetch", lastfmResponse([play(), play({ date: { uts: "1756400000" } })]));

    await syncRecentListens(user.id);
    await syncRecentListens(user.id);
    await syncRecentListens(user.id);

    expect(await prisma.listen.count({ where: { ownerId: user.id } })).toBe(2);
  });

  it("fills in a MusicBrainz id that a later read supplies", async () => {
    const user = await makeUser();
    vi.stubGlobal("fetch", lastfmResponse([play()]));
    await syncRecentListens(user.id);
    expect((await prisma.listen.findFirstOrThrow({})).recordingMbid).toBeNull();

    vi.stubGlobal("fetch", lastfmResponse([play({ mbid: MBID })]));
    await syncRecentListens(user.id);

    expect((await prisma.listen.findFirstOrThrow({})).recordingMbid).toBe(MBID);
    expect(await prisma.listen.count()).toBe(1);
  });

  /** A track still playing is not yet a play Last.fm has reported. */
  it("shows a now-playing track without persisting it", async () => {
    const user = await makeUser();
    vi.stubGlobal(
      "fetch",
      lastfmResponse([play({ date: undefined, "@attr": { nowplaying: "true" } })]),
    );

    const view = await syncRecentListens(user.id);

    expect(view).toHaveLength(1);
    expect(view[0]!.playedAt).toBeNull();
    expect(await prisma.listen.count({ where: { ownerId: user.id } })).toBe(0);
  });

  it("never returns another user's listens", async () => {
    const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
    vi.stubGlobal("fetch", lastfmResponse([play()]));
    await syncRecentListens(alice.id);

    expect(await prisma.listen.count({ where: { ownerId: bob.id } })).toBe(0);
  });
});

describe("what a scrobble is allowed to create", () => {
  async function importFirst(userId: string, body = "a jot") {
    const listen = await prisma.listen.findFirstOrThrow({ where: { ownerId: userId } });
    return importListen(userId, { sourceRef: listen.sourceRef, body });
  }

  /**
   * With a MusicBrainz id there is an identifier to resolve by, so the ordinary
   * trusted-provider path applies.
   */
  it("anchors a play carrying a MusicBrainz id to that identifier", async () => {
    const user = await makeUser();
    vi.stubGlobal("fetch", lastfmResponse([play({ mbid: MBID })]));
    await syncRecentListens(user.id);

    await importFirst(user.id);

    const external = await prisma.recordingExternalId.findUniqueOrThrow({
      where: { provider_providerId: { provider: Provider.musicbrainz, providerId: MBID } },
      include: { recording: true },
    });
    expect(external.recording.origin).toBe(RecordingOrigin.provider);
    expect(external.recording.title).toBe("CN TOWER");
  });

  /**
   * Without one there is nothing but names, and the catalog policy forbids
   * creating a shared entity from those. A creator-scoped row is the correct,
   * duplicate-tolerating answer.
   */
  it("keeps a play with no identifier scoped to its creator", async () => {
    const user = await makeUser();
    vi.stubGlobal("fetch", lastfmResponse([play()]));
    await syncRecentListens(user.id);

    await importFirst(user.id);

    const recording = await prisma.recording.findFirstOrThrow({ where: { title: "CN TOWER" } });
    expect(recording.origin).toBe(RecordingOrigin.user);
    expect(recording.createdById).toBe(user.id);
    expect(await prisma.recordingExternalId.count()).toBe(0);
  });

  /** Last.fm supplies artists and albums as names, and a name is not an id. */
  it("creates no artist or album rows from what Last.fm called things", async () => {
    const user = await makeUser();
    vi.stubGlobal("fetch", lastfmResponse([play({ mbid: MBID })]));
    await syncRecentListens(user.id);

    await importFirst(user.id);

    expect(await prisma.artist.count()).toBe(0);
    expect(await prisma.album.count()).toBe(0);
    // The album title survives as display data, which is what it is.
    const recording = await prisma.recording.findFirstOrThrow({});
    expect(recording.releaseTitle).toBe("$ome $exy $ongs 4 U");
  });

  it("reuses a recording already held under the same MusicBrainz id", async () => {
    const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
    vi.stubGlobal("fetch", lastfmResponse([play({ mbid: MBID })]));
    await syncRecentListens(alice.id);
    await syncRecentListens(bob.id);

    await importFirst(alice.id, "alice heard it");
    await importFirst(bob.id, "bob heard it");

    expect(await prisma.recording.count()).toBe(1);
    expect(await prisma.note.count()).toBe(2);
  });

  it("gives two people two rows when there is no identifier to share", async () => {
    const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
    vi.stubGlobal("fetch", lastfmResponse([play()]));
    await syncRecentListens(alice.id);
    await syncRecentListens(bob.id);

    await importFirst(alice.id);
    await importFirst(bob.id);

    // A duplicate is cheap; a false merge is not.
    expect(await prisma.recording.count()).toBe(2);
  });
});

describe("the note a play becomes", () => {
  it("is dated when it was heard, to the minute", async () => {
    const user = await makeUser();
    vi.stubGlobal("fetch", lastfmResponse([play()]));
    await syncRecentListens(user.id);
    const listen = await prisma.listen.findFirstOrThrow({});

    await importListen(user.id, { sourceRef: listen.sourceRef, body: "heard on the walk home" });

    const note = await prisma.note.findFirstOrThrow({ where: { ownerId: user.id } });
    expect(note.experiencedAt?.toISOString()).toBe(PLAYED_AT.toISOString());
    expect(note.experiencedPrecision).toBe(DatePrecision.time);
    // Written now, heard earlier: the two dates are different on purpose.
    expect(note.createdAt.getTime()).toBeGreaterThan(PLAYED_AT.getTime());
  });

  it("is private, like every other note", async () => {
    const user = await makeUser();
    vi.stubGlobal("fetch", lastfmResponse([play()]));
    await syncRecentListens(user.id);
    const listen = await prisma.listen.findFirstOrThrow({});

    await importListen(user.id, { sourceRef: listen.sourceRef, body: "mine" });

    expect((await prisma.note.findFirstOrThrow({})).visibility).toBe("private");
  });

  /**
   * The strip says how many notes exist about a play and points at them — and
   * still offers another. It used to swap the button for a bare "Jotted",
   * which gave no way to the note and no way to write a second one about a song
   * heard again.
   */
  it("counts the notes about a play and points at their recording", async () => {
    const user = await makeUser();
    vi.stubGlobal("fetch", lastfmResponse([play()]));
    await syncRecentListens(user.id);
    const listen = await prisma.listen.findFirstOrThrow({});

    await importListen(user.id, { sourceRef: listen.sourceRef, body: "first thought" });

    const after = await prisma.listen.findUniqueOrThrow({ where: { id: listen.id } });
    expect(after.importedAt).not.toBeNull();
    expect(after.recordingId).not.toBeNull();

    let view = await syncRecentListens(user.id);
    expect(view[0]!.noteCount).toBe(1);
    expect(view[0]!.recordingId).toBe(after.recordingId);

    // A second, deliberate note about the same play is allowed and counted.
    await importListen(user.id, {
      sourceRef: listen.sourceRef,
      body: "second listen, different thought",
      idempotencyKey: "jot_second_note_00000",
    });
    view = await syncRecentListens(user.id);
    expect(view[0]!.noteCount).toBe(2);
  });

  it("refuses a play belonging to somebody else, given its real ref", async () => {
    const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
    vi.stubGlobal("fetch", lastfmResponse([play()]));
    await syncRecentListens(alice.id);
    const hers = await prisma.listen.findFirstOrThrow({ where: { ownerId: alice.id } });

    await expect(
      importListen(bob.id, { sourceRef: hers.sourceRef, body: "not mine to take" }),
    ).rejects.toThrow(LastfmNotLinkedError);
    expect(await prisma.note.count()).toBe(0);
  });

  /**
   * Jotting a song while it plays, then having Last.fm report the finished
   * play, must leave one listen — not the imported one plus an orphan.
   */
  it("folds the completed scrobble into a now-playing capture", async () => {
    const user = await makeUser();
    const nowPlaying = play({ date: undefined, "@attr": { nowplaying: "true" } });
    vi.stubGlobal("fetch", lastfmResponse([nowPlaying]));
    const [live] = await syncRecentListens(user.id);

    await importListen(user.id, {
      sourceRef: live!.sourceRef,
      body: "caught this one live",
      track: {
        trackName: live!.trackName,
        artistName: live!.artistName,
        albumName: live!.albumName,
        playedAt: null,
        recordingMbid: null,
        artistMbid: null,
        albumMbid: null,
        url: live!.url,
        sourceRef: live!.sourceRef,
      },
    });
    expect(await prisma.listen.count({ where: { ownerId: user.id } })).toBe(1);

    // Last.fm now reports the finished play with a real timestamp.
    vi.stubGlobal(
      "fetch",
      lastfmResponse([play({ date: { uts: String(Math.floor(Date.now() / 1000)) } })]),
    );
    await syncRecentListens(user.id);

    const listens = await prisma.listen.findMany({ where: { ownerId: user.id } });
    expect(listens).toHaveLength(1);
    expect(listens[0]!.sourceRef.startsWith("nowplaying:")).toBe(false);
    expect(listens[0]!.importedAt).not.toBeNull();
  });
});

/**
 * Confirming a provider match for a play that arrived with no identifier.
 *
 * This is the path that turns a nameless scrobble into a real recording with
 * artwork, and it is where the catalog policy is genuinely at stake: a name
 * search suggested it, so nothing may be created until a person agrees, and
 * what anchors the row must be the provider's identifier rather than anything
 * the browser sent.
 */
describe("confirming a provider match", () => {
  const APPLE_ID = "1574601348";

  async function playedWithNoMbid() {
    const user = await makeUser();
    vi.stubGlobal("fetch", lastfmResponse([play()]));
    await syncRecentListens(user.id);
    const listen = await prisma.listen.findFirstOrThrow({ where: { ownerId: user.id } });
    return { user, listen };
  }

  /** Apple's lookup, as `captureFromProviderRef` will re-read it. */
  function appleLookup() {
    vi.stubGlobal("fetch", (async () =>
      new Response(
        JSON.stringify({
          resultCount: 1,
          results: [
            {
              wrapperType: "track",
              kind: "song",
              trackId: Number(APPLE_ID),
              trackName: "Rasiya",
              artistId: 1,
              artistName: "Anyasa",
              collectionId: 1574601347,
              collectionName: "Rasiya",
              trackTimeMillis: 228865,
              trackNumber: 1,
              releaseDate: "2021-07-16T07:00:00Z",
              artworkUrl100: "https://is1-ssl.mzstatic.com/image/thumb/x/100x100bb.jpg",
            },
          ],
        }),
      )) as unknown as typeof fetch);
  }

  it("anchors the recording to the confirmed identifier, with artwork", async () => {
    const { user, listen } = await playedWithNoMbid();
    appleLookup();

    await importListen(user.id, {
      sourceRef: listen.sourceRef,
      body: "confirmed it myself",
      confirmed: { provider: Provider.apple_music, providerId: APPLE_ID },
    });

    const external = await prisma.recordingExternalId.findUniqueOrThrow({
      where: { provider_providerId: { provider: Provider.apple_music, providerId: APPLE_ID } },
      include: { recording: true },
    });
    expect(external.recording.origin).toBe(RecordingOrigin.provider);
    // The grey square problem: a confirmed match brings art we may show.
    expect(external.recording.artworkUrl).toContain("mzstatic.com");
  });

  /**
   * The security property. Only the provider and id are honoured; the title,
   * album and artwork are re-read from the provider, so a tampered form cannot
   * inject a name or an image URL.
   */
  it("takes its facts from the provider, not from the caller", async () => {
    const { user, listen } = await playedWithNoMbid();
    appleLookup();

    await importListen(user.id, {
      sourceRef: listen.sourceRef,
      body: "tampered",
      confirmed: { provider: Provider.apple_music, providerId: APPLE_ID },
      track: {
        trackName: "NOT THE REAL TITLE",
        artistName: "NOT THE REAL ARTIST",
        albumName: null,
        playedAt: null,
        recordingMbid: null,
        artistMbid: null,
        albumMbid: null,
        url: "https://evil.example/beacon.png",
        sourceRef: listen.sourceRef,
      },
    });

    const recording = await prisma.recording.findFirstOrThrow({
      where: { externalIds: { some: { providerId: APPLE_ID } } },
    });
    expect(recording.title).toBe("Rasiya");
    expect(recording.artistDisplay).toBe("Anyasa");
    expect(JSON.stringify(recording)).not.toContain("evil.example");
  });

  it("leaves the play creator-scoped when the user confirms nothing", async () => {
    const { user, listen } = await playedWithNoMbid();

    await importListen(user.id, { sourceRef: listen.sourceRef, body: "none of those" });

    const recording = await prisma.recording.findFirstOrThrow({ where: { title: "CN TOWER" } });
    expect(recording.origin).toBe(RecordingOrigin.user);
    expect(await prisma.recordingExternalId.count()).toBe(0);
  });

  /** A provider that cannot confirm its own id must not cost someone their note. */
  it("still writes the note when the provider will not answer", async () => {
    const { user, listen } = await playedWithNoMbid();
    vi.stubGlobal("fetch", (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch);

    await importListen(user.id, {
      sourceRef: listen.sourceRef,
      body: "written regardless",
      confirmed: { provider: Provider.apple_music, providerId: APPLE_ID },
    });

    const note = await prisma.note.findFirstOrThrow({ where: { ownerId: user.id } });
    expect(note.body).toBe("written regardless");
    // Fell back to creator-scoped rather than failing.
    expect(await prisma.recordingExternalId.count()).toBe(0);
  });

  it("files two people's confirmations of the same track as one recording", async () => {
    const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
    vi.stubGlobal("fetch", lastfmResponse([play()]));
    await syncRecentListens(alice.id);
    await syncRecentListens(bob.id);
    const hers = await prisma.listen.findFirstOrThrow({ where: { ownerId: alice.id } });
    const his = await prisma.listen.findFirstOrThrow({ where: { ownerId: bob.id } });

    appleLookup();
    await importListen(alice.id, {
      sourceRef: hers.sourceRef,
      body: "alice",
      confirmed: { provider: Provider.apple_music, providerId: APPLE_ID },
    });
    await importListen(bob.id, {
      sourceRef: his.sourceRef,
      body: "bob",
      confirmed: { provider: Provider.apple_music, providerId: APPLE_ID },
    });

    // The point of acquiring an identifier: one shared row, two private notes.
    expect(await prisma.recording.count()).toBe(1);
    expect(await prisma.note.count()).toBe(2);
  });
});

/**
 * Saving a jot has to be safe to retry.
 *
 * Two writes make one jot — create the note, mark the listen imported — and
 * they were not atomic. A failure between them left a note written and the
 * listen still unimported, so the obvious next move (press Save again) wrote a
 * *second* note about the same play. The transaction closes the window; the
 * idempotency key closes the rest, because a retry that reaches the server
 * twice must still resolve to one note.
 */
describe("saving a jot under retry", () => {
  async function linkedUserWithOneListen() {
    const user = await prisma.user.create({
      data: {
        authSubject: `s_${crypto.randomUUID()}`,
        lastfmUsername: "samah-",
        lastfmSessionKey: "a-session-key",
      },
    });
    vi.stubGlobal("fetch", lastfmResponse([play()]));
    await syncRecentListens(user.id);
    const listen = await prisma.listen.findFirstOrThrow({ where: { ownerId: user.id } });
    return { user, listen };
  }

  it("produces one note when the same submission is sent twice", async () => {
    const { user, listen } = await linkedUserWithOneListen();
    const key = "jot_retry_0000000000";

    const first = await importListen(user.id, {
      sourceRef: listen.sourceRef,
      body: "the city sounds under the intro",
      idempotencyKey: key,
    });
    const second = await importListen(user.id, {
      sourceRef: listen.sourceRef,
      body: "the city sounds under the intro",
      idempotencyKey: key,
    });

    expect(second.noteId).toBe(first.noteId);
    expect(await prisma.note.count({ where: { ownerId: user.id } })).toBe(1);
  });

  /**
   * The deliberate case, which must survive all of the above: writing a second,
   * different thought about the same song is something people do on purpose. A
   * fresh editor mints a fresh key, so it still works.
   */
  it("still allows a deliberate second note about the same play", async () => {
    const { user, listen } = await linkedUserWithOneListen();

    const first = await importListen(user.id, {
      sourceRef: listen.sourceRef,
      body: "the city sounds under the intro",
      idempotencyKey: "jot_first_0000000000",
    });
    const second = await importListen(user.id, {
      sourceRef: listen.sourceRef,
      body: "second listen, and the bass is doing something else",
      idempotencyKey: "jot_second_000000000",
    });

    expect(second.noteId).not.toBe(first.noteId);
    expect(await prisma.note.count({ where: { ownerId: user.id } })).toBe(2);
  });

  /**
   * Without a key there is nothing to deduplicate against, and that has to stay
   * true — every other note-writing path in the product omits one.
   */
  it("writes a note when no key is supplied", async () => {
    const { user, listen } = await linkedUserWithOneListen();

    await importListen(user.id, { sourceRef: listen.sourceRef, body: "no key here" });

    expect(await prisma.note.count({ where: { ownerId: user.id } })).toBe(1);
  });
});

/**
 * Earlier listening, one page at a time.
 *
 * Ten rows is a capture aid for what is playing now. A day of listening is more
 * than ten rows, so somebody who sits down in the evening would find the
 * morning already pushed off the strip — with no way back to it. This is the
 * bounded answer: a requested page, not a lifetime import, which the contract
 * keeps out of scope and which should stay out.
 */
describe("reaching earlier listens", () => {
  it("asks Last.fm for the page it was given", async () => {
    const user = await prisma.user.create({
      data: { authSubject: `s_${crypto.randomUUID()}`, lastfmUsername: "samah-" },
    });

    const asked: string[] = [];
    vi.stubGlobal("fetch", (async (url: URL | string) => {
      const href = url.toString();
      asked.push(new URL(href).searchParams.get("page") ?? "(none)");
      return new Response(JSON.stringify({ recenttracks: { track: [] } }));
    }) as unknown as typeof fetch);

    await syncRecentListens(user.id, 10, 3);

    expect(asked).toContain("3");
  });

  /**
   * A page number arrives from a browser, so it is clamped rather than trusted.
   * Asking somebody else's API for page 9,000,000 because a client said so is
   * how an integration becomes a liability to the service it depends on.
   */
  it("clamps a page out of range instead of passing it on", async () => {
    const user = await prisma.user.create({
      data: { authSubject: `s_${crypto.randomUUID()}`, lastfmUsername: "samah-" },
    });

    const asked: string[] = [];
    vi.stubGlobal("fetch", (async (url: URL | string) => {
      asked.push(new URL(url.toString()).searchParams.get("page") ?? "(none)");
      return new Response(JSON.stringify({ recenttracks: { track: [] } }));
    }) as unknown as typeof fetch);

    await syncRecentListens(user.id, 10, 9_000_000);
    await syncRecentListens(user.id, 10, -4);

    expect(asked).toEqual(["20", "1"]);
  });

  /** An earlier page is persisted like any other, so it can be jotted. */
  it("stores what an earlier page returns", async () => {
    const user = await prisma.user.create({
      data: { authSubject: `s_${crypto.randomUUID()}`, lastfmUsername: "samah-" },
    });
    vi.stubGlobal("fetch", lastfmResponse([play()]));

    const listens = await syncRecentListens(user.id, 10, 2);

    expect(listens).toHaveLength(1);
    expect(await prisma.listen.count({ where: { ownerId: user.id } })).toBe(1);
  });
});
