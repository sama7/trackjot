"use client";

import Link from "next/link";
import { useClerk } from "@clerk/nextjs";
import { useState } from "react";
import { deleteAccountAction, deleteListeningHistoryAction } from "./actions";

/**
 * The two ways out.
 *
 * Disconnecting Last.fm deliberately keeps your listens and the notes made from
 * them — a source setting is not a request to delete your writing. That was the
 * right call and it left a gap: there was no way to say the other thing. An
 * account you cannot leave, and a history you cannot erase, are not privacy
 * features however carefully the rest of the product behaves.
 *
 * Both are stated in terms of what survives, because that is the part people
 * actually need to predict.
 */
export function DangerZone({
  username,
  listeningHistoryAvailable,
}: {
  username: string | null;
  /**
   * Gated on the same feature flag as the rest of the integration.
   *
   * Without this the account page named Last.fm on a deployment that has no
   * Last.fm key — which the acceptance suite catches, correctly: an
   * unconfigured deployment must never mention an integration it cannot
   * perform. Offering to delete history that could not exist is also just
   * confusing. Deleting the account is unconditional; it is not about any
   * source.
   */
  listeningHistoryAvailable: boolean;
}) {
  return (
    <>
      <h2>Deleting things</h2>

      {listeningHistoryAvailable && <DeleteHistory />}
      <DeleteAccount username={username} />
    </>
  );
}

function DeleteHistory() {
  const [state, setState] = useState<{ error?: string; done?: string }>({});
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="capture"
      action={async () => {
        if (
          !confirm(
            "Delete the plays you haven’t written about? Listens you already jotted are kept, because deleting those would delete the notes.",
          )
        ) {
          return;
        }
        setBusy(true);
        try {
          setState(await deleteListeningHistoryAction());
        } catch {
          setState({ error: "That didn’t work. Try again." });
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="note">
        <strong>Imported listening history.</strong> Removes the plays TrackJot pulled
        from Last.fm that you never wrote about. Plays you did jot are kept — they are
        what those notes are dated from, so deleting them would take the notes with them.
      </p>
      {state.error && (
        <p role="alert" className="error">
          {state.error}
        </p>
      )}
      {state.done && (
        <p role="status" className="success">
          {state.done}
        </p>
      )}
      <button type="submit" className="danger" disabled={busy}>
        {busy ? "Deleting…" : "Delete unwritten history"}
      </button>
    </form>
  );
}

function DeleteAccount({ username }: { username: string | null }) {
  const { signOut } = useClerk();
  const [state, setState] = useState<{ error?: string; done?: string }>({});
  const [busy, setBusy] = useState(false);
  const expected = username ?? "delete my account";

  if (state.done) {
    return (
      <p role="status" className="success">
        {state.done} <Link href="/">Back to the start</Link>.
      </p>
    );
  }

  return (
    <form
      className="capture"
      action={async (formData) => {
        setBusy(true);
        try {
          const result = await deleteAccountAction(formData);
          if (!result.done) {
            setState(result);
            return;
          }
          /**
           * Leave by a full page load, whatever Clerk's client does.
           *
           * The identity is already deleted on the server, and the server now
           * refuses to re-create it (`isDeletedIdentity`). What is left is this
           * browser's copy of the session token, which stays valid for up to a
           * minute. It is dropped here rather than from the Server Action,
           * because changing a cookie inside an action makes Next re-render
           * the page in that same request — still signed in, which is exactly
           * how the account used to come straight back.
           *
           * `signOut()` tidies Clerk's client state but rejects once the user no
           * longer exists, and waiting on it left the page sitting on "deleted"
           * while still looking signed in. So it gets a moment, and then we go
           * regardless; a hard navigation also drops every cached page.
           */
          setState(result);
          for (const pair of document.cookie.split(";")) {
            const name = pair.split("=")[0]?.trim() ?? "";
            if (name === "__session" || name.startsWith("__session_")) {
              document.cookie = `${name}=; Max-Age=0; path=/`;
            }
          }
          await Promise.race([
            signOut().catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, 2_000)),
          ]);
          window.location.assign(new URL("/?account=deleted", window.location.origin).href);
          return;
        } catch {
          setState({ error: "That didn’t work. Try again." });
        } finally {
          setBusy(false);
        }
      }}
    >
      <p className="note">
        <strong>Your whole account.</strong> Every note, collection, tag, listen and
        anything you typed in yourself, permanently and immediately. Shared links stop
        working, and you are signed out everywhere. This cannot be undone. Signing in
        again afterwards — with Google or by email — starts a brand-new, empty account.
      </p>
      <div className="field">
        <label htmlFor="confirm">
          Type <strong>{expected}</strong> to confirm
        </label>
        <input id="confirm" name="confirm" autoComplete="off" />
      </div>
      {state.error && (
        <p role="alert" className="error">
          {state.error}
        </p>
      )}
      <button type="submit" className="danger" disabled={busy}>
        {busy ? "Deleting…" : "Delete my account"}
      </button>
    </form>
  );
}
