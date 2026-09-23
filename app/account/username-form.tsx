"use client";

import { useActionState, useState } from "react";
import { UsernameField } from "@/components/username-field";
import { checkUsernameAction } from "../welcome/actions";
import { setUsernameAction, type UsernameState } from "./actions";

/**
 * Change a handle.
 *
 * Choosing one is required at sign-up (`/welcome`); this is where it changes
 * afterwards, with the same as-you-type availability check and the same
 * suggestions when a name is taken.
 */
export function UsernameForm({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState<UsernameState, FormData>(
    setUsernameAction,
    {},
  );
  /**
   * A claimed username reads; it does not sit in an open text field.
   *
   * The form rendered an editable input on arrival, so the account page looked
   * like it was mid-edit every time it loaded — and a handle that is already
   * yours is a fact about your account, not a form waiting to be filled in.
   * Editing is a thing you ask for.
   *
   * Still an input from the start when there is no username yet: there the page
   * *is* asking for something, and hiding that behind a button would bury the
   * one prompt that matters before the social surfaces exist.
   */
  const [editing, setEditing] = useState(current === null);

  /**
   * A successful save settles back to reading — adjusted during render, not in
   * an effect.
   *
   * Setting state from an effect to mirror another value renders the tree
   * twice and is what the cascading-render lint rule exists to catch. React
   * supports adjusting state *while rendering* for exactly this case: compare
   * against the previous value, and if it changed, correct course before
   * anything is painted.
   */
  const [seenSaved, setSeenSaved] = useState(state.saved);
  if (state.saved !== seenSaved) {
    setSeenSaved(state.saved);
    if (state.saved) setEditing(false);
  }

  const claimed = state.saved ?? current;

  if (!editing) {
    return (
      <div className="capture">
        <div className="field">
          <span className="note">Username</span>
          <p className="username-current">
            <strong>{claimed}</strong>
          </p>
        </div>

        {state.saved && (
          <p role="status" className="success">
            You&rsquo;re <strong>{state.saved}</strong>.
          </p>
        )}

        <div className="row actions">
          <button type="button" className="linkish" onClick={() => setEditing(true)}>
            Change it
          </button>
        </div>

        <p className="note">
          Not shown to anyone yet. It is what a profile and a mention will use when
          following and tagging arrive.
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="capture">
      <div className="field">
        <label htmlFor="username">Username</label>
        <UsernameField
          autoFocus={current !== null}
          defaultValue={claimed ?? ""}
          check={checkUsernameAction}
          describedBy="hint-username"
        />
        {/* The rule used to be the placeholder, where on a phone it was cut to
            "3–30 characters: letters, numbers, und" — and a placeholder also
            disappears the moment someone starts typing, which is when the rule
            is actually needed. Below the field it wraps, and it stays. */}
        <p id="hint-username" className="note hint">
          3–30 characters: letters, numbers, underscores.
        </p>
      </div>

      {state.error && (
        <p role="alert" className="error">
          {state.error}
          {state.suggestions && state.suggestions.length > 0 && (
            <> Free right now: {state.suggestions.join(", ")}.</>
          )}
        </p>
      )}

      <div className="row">
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : current ? "Save" : "Claim it"}
        </button>
        {/* No cancel when there is nothing to go back to. */}
        {current !== null && (
          <button type="button" className="linkish" onClick={() => setEditing(false)}>
            Cancel
          </button>
        )}
      </div>

      <p className="note">
        Not shown to anyone yet. It is what a profile and a mention will use when
        following and tagging arrive, and claiming it now means not racing everyone
        else for it later.
      </p>
    </form>
  );
}
