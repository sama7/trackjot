import { ListenSource, PrismaClient, Provider, RecordingOrigin } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createNote } from "@/lib/notes/service";
import { setNoteTags } from "@/lib/notes/tags";
import { deleteAccount } from "@/lib/users/delete-account";
import { DeletedIdentityError, resolveLocalUser } from "@/lib/auth";
import { checkUsername, setUsername, suggestUsernames } from "@/lib/users/username";
import { resetDatabase } from "./reset";

const prisma = new PrismaClient();

beforeEach(async () => {
  await resetDatabase(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function makeUser(username?: string) {
  return prisma.user.create({
    data: { authSubject: `user_${crypto.randomUUID()}`, username },
  });
}

async function providerRecording(title: string) {
  return prisma.recording.create({
    data: {
      title,
      artistDisplay: "Shared Artist",
      origin: RecordingOrigin.provider,
      normalizedKey: `k_${crypto.randomUUID()}`,
      externalIds: {
        create: { provider: Provider.spotify, providerId: `p_${crypto.randomUUID()}` },
      },
    },
  });
}

/**
 * Somebody with a bit of everything: notes on a shared track and on a track
 * they typed in themselves, tags, a collection with an item, and a listen.
 */
async function populatedUser() {
  const user = await makeUser("leaving");
  const shared = await providerRecording("Shared track");
  const typed = await prisma.recording.create({
    data: {
      title: "Typed in",
      artistDisplay: "Someone",
      origin: RecordingOrigin.user,
      createdById: user.id,
      normalizedKey: `k_${crypto.randomUUID()}`,
    },
  });
  const a = await createNote(user.id, { recordingId: shared.id, body: "on the shared one" });
  await createNote(user.id, { recordingId: typed.id, body: "on my own entry" });
  await setNoteTags(user.id, a.id, ["late night"]);
  await prisma.collection.create({
    data: {
      ownerId: user.id,
      name: "Mine",
      items: { create: { recordingId: shared.id, position: 0 } },
    },
  });
  await prisma.listen.create({
    data: {
      ownerId: user.id,
      source: ListenSource.lastfm,
      sourceRef: `ref_${crypto.randomUUID()}`,
      playedAt: new Date(),
      trackName: "Shared track",
      artistName: "Shared Artist",
    },
  });
  return { user, shared, typed };
}

async function rowsOwnedBy(ownerId: string) {
  const [notes, tags, collections, listens, users] = await Promise.all([
    prisma.note.count({ where: { ownerId } }),
    prisma.tag.count({ where: { ownerId } }),
    prisma.collection.count({ where: { ownerId } }),
    prisma.listen.count({ where: { ownerId } }),
    prisma.user.count({ where: { id: ownerId } }),
  ]);
  return { notes, tags, collections, listens, users };
}

describe("deleting an account", () => {
  it("removes every owned row and the sign-in identity", async () => {
    const { user, shared, typed } = await populatedUser();
    const deleteIdentity = vi.fn(async () => {});

    expect(await rowsOwnedBy(user.id)).toEqual({
      notes: 2,
      tags: 1,
      collections: 1,
      listens: 1,
      users: 1,
    });

    const result = await deleteAccount(user, deleteIdentity);

    expect(result).toEqual({ identityDeleted: true });
    expect(deleteIdentity).toHaveBeenCalledExactlyOnceWith(user.authSubject);
    expect(await rowsOwnedBy(user.id)).toEqual({
      notes: 0,
      tags: 0,
      collections: 0,
      listens: 0,
      users: 0,
    });
    // Their own typed-in entry goes; the shared catalog row stays.
    expect(await prisma.recording.findUnique({ where: { id: typed.id } })).toBeNull();
    expect(await prisma.recording.findUnique({ where: { id: shared.id } })).not.toBeNull();
    expect(await prisma.collectionItem.count()).toBe(0);
    expect(await prisma.noteTag.count()).toBe(0);
  });

  it("leaves everyone else's writing alone, including on the same track", async () => {
    const { user, shared } = await populatedUser();
    const other = await makeUser("staying");
    const theirs = await createNote(other.id, { recordingId: shared.id, body: "still mine" });
    await setNoteTags(other.id, theirs.id, ["late night"]);

    await deleteAccount(user, async () => {});

    expect(await rowsOwnedBy(other.id)).toMatchObject({ notes: 1, tags: 1, users: 1 });
  });

  it("treats an identity that is already gone as deleted", async () => {
    const { user } = await populatedUser();
    const result = await deleteAccount(user, async () => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    expect(result).toEqual({ identityDeleted: true });
  });

  /**
   * The data half is the guarantee; the identity half is reported honestly
   * when it fails rather than claimed.
   */
  it("still deletes the data when the identity provider refuses, and says so", async () => {
    const { user } = await populatedUser();
    const result = await deleteAccount(user, async () => {
      throw Object.assign(new Error("Unavailable"), { status: 503 });
    });
    expect(result).toEqual({ identityDeleted: false });
    expect((await rowsOwnedBy(user.id)).users).toBe(0);
  });
});

/**
 * The resurrection bug. A session token issued before the deletion stays valid
 * for about a minute, and users are created lazily on first sight — so any
 * request in that window used to create a fresh, empty account under the
 * deleted identity. That is what "it logged me straight back in" was.
 */
describe("a deleted identity stays deleted", () => {
  it("refuses to lazily re-create the account for a still-valid token", async () => {
    const { user } = await populatedUser();
    await deleteAccount(user, async () => {});

    await expect(resolveLocalUser(user.authSubject)).rejects.toBeInstanceOf(DeletedIdentityError);
    expect(await prisma.user.count({ where: { authSubject: user.authSubject } })).toBe(0);
  });

  it("still creates accounts for everyone else", async () => {
    const { user } = await populatedUser();
    await deleteAccount(user, async () => {});

    const fresh = await resolveLocalUser(`user_${crypto.randomUUID()}`);
    expect(fresh.id).toBeTruthy();
  });

  it("forgets tombstones after a day, keeping nothing long-term", async () => {
    await prisma.identityTombstone.create({
      data: { authSubject: "user_old", deletedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });
    const { user } = await populatedUser();
    await deleteAccount(user, async () => {});

    expect(await prisma.identityTombstone.findMany({ select: { authSubject: true } })).toEqual([
      { authSubject: user.authSubject },
    ]);
  });
});

describe("choosing a username", () => {
  it("offers only names that are actually free", async () => {
    await makeUser("samah");
    await makeUser("samah_");
    await makeUser("the_samah");

    const suggestions = await suggestUsernames("samah");

    expect(suggestions).toHaveLength(3);
    expect(suggestions).not.toContain("samah");
    expect(suggestions).not.toContain("samah_");
    expect(suggestions).not.toContain("the_samah");
    for (const name of suggestions) {
      expect((await checkUsername(name, null)).available).toBe(true);
    }
  });

  it("reports a taken name with alternatives, case-insensitively", async () => {
    await makeUser("samah");
    const check = await checkUsername("SAMAH", null);
    expect(check.available).toBe(false);
    expect(check.message).toMatch(/already has/i);
    expect(check.suggestions.length).toBeGreaterThan(0);
  });

  it("does not call your own name taken", async () => {
    const me = await makeUser("samah");
    expect((await checkUsername("samah", me.id)).available).toBe(true);
  });

  it("rejects the second of two people claiming one name", async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const results = await Promise.all([setUsername(a.id, "contested"), setUsername(b.id, "contested")]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.user.count({ where: { username: "contested" } })).toBe(1);
  });
});
