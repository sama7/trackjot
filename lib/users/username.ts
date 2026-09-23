import { prisma } from "@/lib/db";

/**
 * Usernames.
 *
 * They exist now rather than later for one reason: the moment TrackJot has any
 * social surface — following, tagging someone in a note, a public profile — it
 * needs a stable handle, and retrofitting one onto an existing user base means
 * asking everybody to pick a name at once while the good ones are taken in a
 * stampede. Claiming a handle early costs a field; claiming it afterwards costs
 * a migration and a bad week.
 *
 * The rules are deliberately narrow, and each one is a decision:
 *
 *   - **Lowercased on the way in.** The column is a plain unique index, so case
 *     folding in the application is what makes `Samah` and `samah` the same
 *     person without a citext extension.
 *   - **Letters, digits, underscore; 3–30.** No dots and no hyphens: both invite
 *     confusable pairs (`a.b` / `ab`), and a handle whose job is to identify a
 *     person should be hard to impersonate.
 *   - **Route names are reserved.** A profile is going to live at `/@name` or
 *     `/name`; letting someone take `settings` now is a problem that only
 *     surfaces the day that route ships.
 */

const SHAPE = /^[a-z0-9_]{3,30}$/;

/**
 * Names nobody may claim.
 *
 * Application routes, the obvious impersonation risks, and the words a support
 * or system account would want. Reserving them is cheap now and impossible
 * later.
 */
const RESERVED = new Set([
  "about", "account", "admin", "api", "auth", "c", "collection", "collections",
  "contact", "explore", "feed", "help", "home", "invite", "legal", "login",
  "logout", "me", "n", "new", "note", "notes", "privacy", "profile", "root",
  "search", "security", "settings", "signin", "signup", "sign_in", "sign_up",
  "staff", "support", "system", "tag", "tags", "terms", "trackjot", "user",
  "users", "www",
]);

export type UsernameProblem = "shape" | "reserved" | "taken";

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Format and reserved-word checks. Does not touch the database. */
export function checkUsernameShape(raw: string): UsernameProblem | null {
  const name = normalizeUsername(raw);
  if (!SHAPE.test(name)) return "shape";
  if (RESERVED.has(name)) return "reserved";
  return null;
}

export function describeProblem(problem: UsernameProblem): string {
  switch (problem) {
    case "shape":
      return "Usernames are 3–30 characters, using letters, numbers and underscores.";
    case "reserved":
      return "That one is reserved. Try another.";
    case "taken":
      return "Someone already has that one.";
  }
}

/**
 * Claim a username for a user.
 *
 * The uniqueness check and the write are one statement rather than a read
 * followed by a write: two people typing the same handle at the same instant is
 * exactly the case a check-then-set gets wrong, so the unique index settles it
 * and the conflict is caught here.
 */
export async function setUsername(
  userId: string,
  raw: string,
): Promise<{ ok: true; username: string } | { ok: false; problem: UsernameProblem }> {
  const problem = checkUsernameShape(raw);
  if (problem) return { ok: false, problem };

  const username = normalizeUsername(raw);
  try {
    await prisma.user.update({ where: { id: userId }, data: { username } });
    return { ok: true, username };
  } catch {
    // The only unique constraint on this update is the username itself.
    return { ok: false, problem: "taken" };
  }
}

export async function isUsernameAvailable(raw: string): Promise<boolean> {
  if (checkUsernameShape(raw)) return false;
  const existing = await prisma.user.findUnique({
    where: { username: normalizeUsername(raw) },
    select: { id: true },
  });
  return !existing;
}

/**
 * Turn anything — an email's local part, a display name — into a candidate
 * that passes the shape rules, or null if nothing usable is left.
 */
export function toUsernameCandidate(raw: string): string | null {
  const cleaned = raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 30);
  if (cleaned.length < 3) return null;
  return checkUsernameShape(cleaned) === "reserved" ? `${cleaned.slice(0, 26)}_fan` : cleaned;
}

/**
 * Up to `count` available handles close to what was asked for.
 *
 * A bare "taken" is a dead end: the person is left guessing variations and
 * submitting them one at a time. Offering a few that are known to be free
 * turns it into a choice. Candidates are checked against the database in one
 * query, so this is a single round trip however many are proposed.
 */
export async function suggestUsernames(raw: string, count = 3): Promise<string[]> {
  const base = toUsernameCandidate(raw);
  if (!base) return [];

  const stem = base.slice(0, 25);
  const year = new Date().getFullYear() % 100;
  const candidates = [
    `${stem}_`,
    `${stem}${year}`,
    `the_${stem}`.slice(0, 30),
    `${stem}_music`.slice(0, 30),
    ...Array.from({ length: 6 }, (_, i) => `${stem}${i + 2}`),
    ...Array.from({ length: 4 }, () => `${stem}${Math.floor(100 + Math.random() * 900)}`),
  ].filter((c, i, all) => !checkUsernameShape(c) && all.indexOf(c) === i && c !== base);

  const taken = new Set(
    (
      await prisma.user.findMany({
        where: { username: { in: candidates } },
        select: { username: true },
      })
    ).map((u) => u.username),
  );
  return candidates.filter((c) => !taken.has(c)).slice(0, count);
}

export interface UsernameCheck {
  available: boolean;
  message: string | null;
  suggestions: string[];
}

/**
 * Is this handle free for *this* user?
 *
 * Their own current username counts as available: re-saving it is not a
 * conflict, and telling someone their own name is "taken" would be absurd.
 */
export async function checkUsername(raw: string, forUserId: string | null): Promise<UsernameCheck> {
  const problem = checkUsernameShape(raw);
  if (problem) {
    return {
      available: false,
      message: describeProblem(problem),
      suggestions: problem === "reserved" ? await suggestUsernames(raw) : [],
    };
  }
  const existing = await prisma.user.findUnique({
    where: { username: normalizeUsername(raw) },
    select: { id: true },
  });
  if (!existing || existing.id === forUserId) {
    return { available: true, message: null, suggestions: [] };
  }
  return { available: false, message: describeProblem("taken"), suggestions: await suggestUsernames(raw) };
}
