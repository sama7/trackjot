import { PrismaClient, DatePrecision, PlacePrecision, Provider, RecordingOrigin, Visibility } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { browseNotes } from "@/lib/notes/browse";
import { createNote, setNoteVisibility, updateNote } from "@/lib/notes/service";
import { setNoteTags } from "@/lib/notes/tags";
import { collectExport, toCsv, toJson, toMarkdown } from "@/lib/notes/export";
import { resetDatabase } from "./reset";

const prisma = new PrismaClient();

/**
 * What a note carries beyond its text, and what "edited" is allowed to mean.
 */

async function makeUser() {
  return prisma.user.create({ data: { authSubject: `s_${crypto.randomUUID()}` } });
}

async function makeRecording(title: string, artist = "Test Artist", album?: string) {
  return prisma.recording.create({
    data: {
      title,
      artistDisplay: artist,
      releaseTitle: album ?? null,
      origin: RecordingOrigin.provider,
      normalizedKey: `k_${crypto.randomUUID()}`,
      externalIds: {
        create: { provider: Provider.spotify, providerId: `p_${crypto.randomUUID()}` },
      },
    },
  });
}

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * The timestamp on a note card says "edited". It has to mean the writing
 * changed, or it means nothing — so this pins down exactly which operations
 * count.
 */
/**
 * Put a measurable gap between two writes.
 *
 * `updated_at` has millisecond resolution and these operations take less than
 * that, so "the edit came after the create" was true in fact and not always
 * true in the timestamp — the assertion failed intermittently, and did so more
 * often once the machine got faster. Waiting a couple of milliseconds makes the
 * ordering observable without weakening what is being asserted: the alternative
 * was `toBeGreaterThanOrEqual`, which would also pass if the field were never
 * touched at all, and that is the whole thing under test.
 */
async function aMomentLater(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("what counts as editing a note", () => {
  async function aNote() {
    const user = await makeUser();
    const recording = await makeRecording("CN TOWER");
    const note = await createNote(user.id, { recordingId: recording.id, body: "first" });
    return { user, note };
  }

  it("changing the visibility does not", async () => {
    const { user, note } = await aNote();

    const after = await setNoteVisibility(user.id, note.id, Visibility.unlisted);

    expect(after.updatedAt.getTime()).toBe(note.updatedAt.getTime());
    expect(after.visibility).toBe(Visibility.unlisted);
  });

  it("going private again does not either", async () => {
    const { user, note } = await aNote();
    await setNoteVisibility(user.id, note.id, Visibility.public);

    const after = await setNoteVisibility(user.id, note.id, Visibility.private);

    expect(after.updatedAt.getTime()).toBe(note.updatedAt.getTime());
    expect(after.shareToken).toBeNull();
  });

  it("changing the body does", async () => {
    const { user, note } = await aNote();
    await aMomentLater();
    const after = await updateNote(user.id, note.id, { body: "second" });
    expect(after.updatedAt.getTime()).toBeGreaterThan(note.updatedAt.getTime());
  });

  /** Tags live in a join table, so this used to leave the note row untouched. */
  it("changing the tags does", async () => {
    const { user, note } = await aNote();
    await aMomentLater();
    await setNoteTags(user.id, note.id, ["late night"]);

    const after = await prisma.note.findUniqueOrThrow({ where: { id: note.id } });
    expect(after.updatedAt.getTime()).toBeGreaterThan(note.updatedAt.getTime());
  });
});

describe("when and where a note happened", () => {
  it("stores a date with the precision that was claimed", async () => {
    const user = await makeUser();
    const recording = await makeRecording("CN TOWER");
    const note = await createNote(user.id, {
      recordingId: recording.id,
      body: "a gig years ago",
      experiencedAt: new Date("2011-01-01T12:00:00Z"),
      experiencedPrecision: DatePrecision.year,
    });

    expect(note.experiencedPrecision).toBe(DatePrecision.year);
    expect(note.experiencedAt?.toISOString()).toContain("2011");
  });

  /** The database CHECK, exercised rather than trusted. */
  it("refuses a date with no precision", async () => {
    const user = await makeUser();
    const recording = await makeRecording("CN TOWER");

    await expect(
      prisma.note.create({
        data: {
          ownerId: user.id,
          recordingId: recording.id,
          body: "half a claim",
          experiencedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses coordinates unless the place was marked exact", async () => {
    const user = await makeUser();
    const recording = await makeRecording("CN TOWER");

    await expect(
      prisma.note.create({
        data: {
          ownerId: user.id,
          recordingId: recording.id,
          body: "tracking me by accident",
          placeLabel: "Toronto",
          placePrecision: PlacePrecision.area,
          placeLat: 43.65,
          placeLon: -79.38,
        },
      }),
    ).rejects.toThrow();
  });
});

describe("browsing", () => {
  async function library() {
    const user = await makeUser();
    const [cn, darling, iceman] = await Promise.all([
      makeRecording("CN TOWER", "PARTYNEXTDOOR", "$ome $exy $ongs 4 U"),
      makeRecording("Darling, I", "Tyler, The Creator", "IGOR"),
      makeRecording("Aardvark", "Zeta", "IGOR"),
    ]);

    await createNote(user.id, {
      recordingId: cn.id,
      body: "one",
      experiencedAt: new Date("2025-06-01T12:00:00Z"),
      experiencedPrecision: DatePrecision.day,
      placeLabel: "Toronto",
      placePrecision: PlacePrecision.area,
    });
    await createNote(user.id, {
      recordingId: darling.id,
      body: "two",
      experiencedAt: new Date("2019-05-17T12:00:00Z"),
      experiencedPrecision: DatePrecision.day,
      placeLabel: "Reykjavik",
      placePrecision: PlacePrecision.area,
    });
    await createNote(user.id, { recordingId: iceman.id, body: "three" });

    return { user };
  }

  it("sorts by track name", async () => {
    const { user } = await library();
    const asc = await browseNotes(user.id, { sort: "track", direction: "asc" });
    expect(asc.map((n) => n.recording?.title)).toEqual(["Aardvark", "CN TOWER", "Darling, I"]);

    const desc = await browseNotes(user.id, { sort: "track", direction: "desc" });
    expect(desc.map((n) => n.recording?.title)).toEqual(["Darling, I", "CN TOWER", "Aardvark"]);
  });

  it("sorts by artist name", async () => {
    const { user } = await library();
    const asc = await browseNotes(user.id, { sort: "artist", direction: "asc" });
    expect(asc.map((n) => n.recording?.artistDisplay)).toEqual([
      "PARTYNEXTDOOR",
      "Tyler, The Creator",
      "Zeta",
    ]);
  });

  it("filters by album, matching the denormalized title too", async () => {
    const { user } = await library();
    const found = await browseNotes(user.id, { album: "igor" });
    expect(found).toHaveLength(2);
  });

  it("filters by place and by a date range on when it was heard", async () => {
    const { user } = await library();

    expect(await browseNotes(user.id, { place: "toronto" })).toHaveLength(1);
    expect(
      await browseNotes(user.id, {
        from: new Date("2025-01-01T00:00:00Z"),
        to: new Date("2025-12-31T23:59:59Z"),
      }),
    ).toHaveLength(1);
  });

  it("never returns another user's notes, however it is sorted", async () => {
    await library();
    const stranger = await makeUser();

    expect(await browseNotes(stranger.id, { sort: "track" })).toHaveLength(0);
    expect(await browseNotes(stranger.id, { album: "igor" })).toHaveLength(0);
  });
});

describe("export", () => {
  async function withNote() {
    const user = await makeUser();
    const recording = await makeRecording("CN TOWER", "PARTYNEXTDOOR", "$ome $exy $ongs 4 U");
    const note = await createNote(user.id, {
      recordingId: recording.id,
      body: 'A body with a "quote", a comma, and\na newline.',
      experiencedAt: new Date("2025-06-01T12:00:00Z"),
      experiencedPrecision: DatePrecision.day,
      placeLabel: "Toronto",
      placePrecision: PlacePrecision.area,
    });
    await setNoteTags(user.id, note.id, ["late night", "drives"]);
    return { user };
  }

  it("includes everything the user wrote, in all three formats", async () => {
    const { user } = await withNote();
    const notes = await collectExport(user.id);

    expect(notes).toHaveLength(1);
    expect(notes[0]!.track).toBe("CN TOWER");
    expect(notes[0]!.tags.sort()).toEqual(["drives", "late night"]);

    expect(JSON.parse(toJson(notes)).notes[0].place).toBe("Toronto");
    expect(toMarkdown(notes)).toContain("CN TOWER — PARTYNEXTDOOR");
    expect(toMarkdown(notes)).toContain("Place: Toronto");
  });

  /**
   * A note body routinely contains the three characters that break a naive CSV.
   * Quoting unconditionally is what keeps the file openable.
   */
  it("quotes CSV fields so a body with commas, quotes and newlines survives", async () => {
    const { user } = await withNote();
    const csv = toCsv(await collectExport(user.id));

    // The body is wrapped in quotes, its own quotes are doubled, and the
    // newline survives inside the field rather than ending the record.
    expect(csv).toContain('"A body with a ""quote"", a comma, and\na newline."');
    expect(csv.split("\r\n")[0]).toContain("experienced_at");
    // The record separator is CRLF, so the LF inside the body cannot be
    // mistaken for the end of the row.
    expect(csv.split("\r\n")).toHaveLength(2);
  });

  it("exports nothing belonging to anyone else", async () => {
    const { user } = await withNote();
    const stranger = await makeUser();

    expect(await collectExport(stranger.id)).toEqual([]);
    expect(await collectExport(user.id)).toHaveLength(1);
  });
});
