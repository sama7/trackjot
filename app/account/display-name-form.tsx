"use client";

import { useActionState, useState } from "react";
import { DISPLAY_NAME_MAX } from "@/lib/users/display-name";
import { setDisplayNameAction, type DisplayNameState } from "./actions";

/**
 * The optional name shown beside your username.
 *
 * Reads until you ask to change it, like the username above it — a setting you
 * already chose is a fact about the account, not a form waiting to be filled.
 */
export function DisplayNameForm({ current }: { current: string | null }) {
  const [state, action, pending] = useActionState<DisplayNameState, FormData>(
    setDisplayNameAction,
    {},
  );
  const [editing, setEditing] = useState(false);

  // Settle back to reading after a save — adjusted during render, not in an effect.
  const [seenSaved, setSeenSaved] = useState(state.saved);
  if (state.saved !== seenSaved) {
    setSeenSaved(state.saved);
    setEditing(false);
  }

  const shown = state.saved !== undefined ? state.saved : current;

  if (!editing) {
    return (
      <div className="capture">
        <div className="field">
          <span className="note">Display name</span>
          <p className="username-current">
            {shown ? <strong>{shown}</strong> : <span className="note">Not set — your username is used</span>}
          </p>
        </div>
        <div className="row actions">
          <button type="button" className="linkish" onClick={() => setEditing(true)}>
            {shown ? "Change it" : "Add one"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="capture">
      <div className="field">
        <label htmlFor="displayName">
          Display name <span className="note">(optional)</span>
        </label>
        <input
          id="displayName"
          name="displayName"
          defaultValue={shown ?? ""}
          maxLength={DISPLAY_NAME_MAX}
          autoComplete="nickname"
          aria-describedby="hint-display"
          autoFocus
        />
        <p id="hint-display" className="note hint">
          Any name you like — a pseudonym is fine. Leave it empty to use your username.
        </p>
      </div>
      {state.error && (
        <p role="alert" className="error">
          {state.error}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
        <button type="button" className="linkish" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
