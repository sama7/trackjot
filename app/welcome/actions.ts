"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser, safeReturnPath } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { checkUsername, describeProblem, setUsername, suggestUsernames, type UsernameCheck } from "@/lib/users/username";
import { normalizeDisplayName } from "@/lib/users/display-name";

/** As-you-type availability, for the onboarding step and the account page. */
export async function checkUsernameAction(raw: string): Promise<UsernameCheck> {
  const user = await requireUser();
  return checkUsername(raw, user.id);
}

export interface OnboardingState {
  error?: string;
  suggestions?: string[];
}

/**
 * Finish joining: a username, required, and a display name, optional.
 *
 * Only a same-site `next` is followed, so this cannot be turned into an open
 * redirect by a crafted sign-up link.
 */
export async function completeOnboardingAction(
  _previous: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  const user = await requireUser();
  const raw = String(formData.get("username") ?? "");

  const result = await setUsername(user.id, raw);
  if (!result.ok) {
    return {
      error: describeProblem(result.problem),
      suggestions: result.problem === "shape" ? [] : await suggestUsernames(raw),
    };
  }

  const displayName = normalizeDisplayName(String(formData.get("displayName") ?? ""));
  await prisma.user.update({ where: { id: user.id }, data: { displayName } });

  revalidatePath("/", "layout");
  redirect(safeReturnPath(String(formData.get("next") ?? "")));
}
