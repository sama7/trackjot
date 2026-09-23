"use server";

import { revalidatePath } from "next/cache";
import { clerkClient } from "@clerk/nextjs/server";
import { requireUser } from "@/lib/auth";
import { deleteAccount } from "@/lib/users/delete-account";
import { prisma } from "@/lib/db";
import { describeProblem, setUsername, suggestUsernames } from "@/lib/users/username";
import { normalizeDisplayName } from "@/lib/users/display-name";

export interface UsernameState {
  error?: string;
  saved?: string;
  /** Free alternatives, offered when the requested name was taken. */
  suggestions?: string[];
}

/**
 * Claim or change a username.
 *
 * The acting user comes from the session, never from the form — the same rule
 * every other mutation follows, and the one v1 broke.
 */
export async function setUsernameAction(
  _previous: UsernameState,
  formData: FormData,
): Promise<UsernameState> {
  const user = await requireUser();
  const requested = String(formData.get("username") ?? "");

  const result = await setUsername(user.id, requested);
  if (!result.ok) {
    return {
      error: describeProblem(result.problem),
      suggestions: result.problem === "taken" ? await suggestUsernames(requested) : [],
    };
  }

  revalidatePath("/account");
  return { saved: result.username };
}

export interface DisplayNameState {
  error?: string;
  /** What was stored — null when cleared back to "use the username". */
  saved?: string | null;
}

/** Set or clear the optional display name. */
export async function setDisplayNameAction(
  _previous: DisplayNameState,
  formData: FormData,
): Promise<DisplayNameState> {
  const user = await requireUser();
  const displayName = normalizeDisplayName(String(formData.get("displayName") ?? ""));
  await prisma.user.update({ where: { id: user.id }, data: { displayName } });
  revalidatePath("/account");
  return { saved: displayName };
}


export interface TimeZoneState {
  error?: string;
  saved?: string;
}

/**
 * Choose the zone this account reads times in.
 *
 * Validated against the runtime's own zone database rather than a regex. An
 * unknown IANA name would not fail here — it would fail later, inside
 * `Intl.DateTimeFormat` during a render, turning a bad setting into a broken
 * page. Asking `Intl` whether it knows the name is the same check the renderer
 * will make, made early.
 */
export async function setTimeZoneAction(formData: FormData): Promise<TimeZoneState> {
  const user = await requireUser();
  const requested = String(formData.get("timeZone") ?? "").trim();
  if (!requested) return { error: "Pick a time zone." };

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: requested });
  } catch {
    return { error: "That is not a time zone this server recognises." };
  }

  await prisma.user.update({ where: { id: user.id }, data: { timeZone: requested } });

  revalidatePath("/account");
  revalidatePath("/notes");
  revalidatePath("/collections");
  return { saved: requested };
}


export interface DangerState {
  error?: string;
  done?: string;
}

/**
 * Delete the imported listening history, keeping the writing.
 *
 * Disconnecting Last.fm deliberately keeps your listens and the notes made from
 * them — a source setting is not a request to delete your own writing. But that
 * left no way to say the other thing: "I want the history itself gone." This is
 * that, and it is careful about the difference.
 *
 * A listen that became a note is **not** deleted. The note is the writing, the
 * listen is the evidence it came from, and the recording it resolved to is what
 * makes the note render at all. Unimported listens carry no writing and are
 * pure history, so those go. Saying so plainly in the UI matters more than the
 * distinction being clever.
 */
export async function deleteListeningHistoryAction(): Promise<DangerState> {
  const user = await requireUser();

  const { count } = await prisma.listen.deleteMany({
    where: { ownerId: user.id, importedAt: null },
  });

  revalidatePath("/account");
  revalidatePath("/notes");
  return {
    done:
      count === 0
        ? "There was no unwritten listening history to delete."
        : `Deleted ${count} listen${count === 1 ? "" : "s"} you hadn’t written about.`,
  };
}

/**
 * Delete the account and everything in it.
 *
 * Typing the username back is the confirmation, not a checkbox: this is the one
 * action in the product with no undo, and it should cost a deliberate sentence.
 *
 * The local row goes and every owned row goes with it by cascade; then the
 * Clerk identity is deleted, which revokes its sessions everywhere — see
 * `lib/users/delete-account.ts` for why leaving it in place resurrected the
 * account one redirect later.
 */
export async function deleteAccountAction(formData: FormData): Promise<DangerState> {
  const user = await requireUser();
  const typed = String(formData.get("confirm") ?? "").trim();
  const expected = user.username ?? "delete my account";

  if (typed.toLowerCase() !== expected.toLowerCase()) {
    return { error: `Type “${expected}” exactly to confirm.` };
  }

  const { identityDeleted } = await deleteAccount(user, async (authSubject) => {
    const clerk = await clerkClient();
    await clerk.users.deleteUser(authSubject);
  });

  if (!identityDeleted) {
    return {
      done:
        "Everything you kept here has been deleted. Your sign-in could not be removed just now, " +
        "so signing in again would start a new, empty account.",
    };
  }
  return { done: "Your account and everything in it has been deleted." };
}
