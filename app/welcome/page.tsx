import { currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { requireUser, safeReturnPath } from "@/lib/auth";
import { checkUsername, suggestUsernames, toUsernameCandidate } from "@/lib/users/username";
import { WelcomeForm } from "./welcome-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Choose a username" };

/**
 * The one step between signing in and using TrackJot: choosing a username.
 *
 * It sits here — after authentication, before the app — rather than inside
 * Clerk's sign-up form, because the rules and the uniqueness check live in our
 * database, and a field on somebody else's form cannot suggest an available
 * alternative from it. Every signed-in page sends an account without a username
 * here, so the step cannot be skipped by going around it.
 *
 * Choosing a username publishes nothing. Notes stay private by default; the
 * handle is only what a share is attributed to, and what following will use.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [params, user] = await Promise.all([searchParams, requireUser()]);
  const next = safeReturnPath(params.next);
  if (user.username) redirect(next);

  /**
   * A starting suggestion from the email address or the name the sign-in
   * provider already knows, checked for availability before it is offered —
   * pre-filling a name that is already taken would fail the first submit.
   */
  const clerk = await currentUser();
  const email = clerk?.primaryEmailAddress?.emailAddress ?? clerk?.emailAddresses[0]?.emailAddress ?? "";
  const fromEmail = toUsernameCandidate(email.split("@")[0] ?? "");
  let suggested = "";
  if (fromEmail) {
    suggested = (await checkUsername(fromEmail, user.id)).available
      ? fromEmail
      : ((await suggestUsernames(fromEmail, 1))[0] ?? "");
  }
  const suggestedDisplayName = [clerk?.firstName, clerk?.lastName].filter(Boolean).join(" ");

  return (
    <main className="narrow-main">
      <h1>Choose a username</h1>
      <p className="lede">
        It identifies you when you share something, and it is how friends will find you.
        Your notes stay private by default — choosing a name publishes nothing.
      </p>
      <WelcomeForm suggested={suggested} suggestedDisplayName={suggestedDisplayName} next={next} />
    </main>
  );
}
