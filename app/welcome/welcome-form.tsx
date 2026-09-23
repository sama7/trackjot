"use client";

import { useActionState } from "react";
import { UsernameField } from "@/components/username-field";
import { DISPLAY_NAME_MAX } from "@/lib/users/display-name";
import { checkUsernameAction, completeOnboardingAction, type OnboardingState } from "./actions";

export function WelcomeForm({
  suggested,
  suggestedDisplayName,
  next,
}: {
  suggested: string;
  suggestedDisplayName: string;
  next: string;
}) {
  const [state, action, pending] = useActionState<OnboardingState, FormData>(
    completeOnboardingAction,
    {},
  );

  return (
    <form action={action} className="capture welcome-form">
      <input type="hidden" name="next" value={next} />

      <div className="field">
        <label htmlFor="username">Username</label>
        <UsernameField
          defaultValue={suggested}
          check={checkUsernameAction}
          describedBy="hint-username"
        />
        <p id="hint-username" className="note hint">
          3–30 characters: letters, numbers, underscores. It is how people will find
          and mention you. You can change it later.
        </p>
      </div>

      <div className="field">
        <label htmlFor="displayName">
          Display name <span className="note">(optional)</span>
        </label>
        <input
          id="displayName"
          name="displayName"
          defaultValue={suggestedDisplayName}
          maxLength={DISPLAY_NAME_MAX}
          autoComplete="nickname"
          aria-describedby="hint-display"
        />
        <p id="hint-display" className="note hint">
          Any name you like — a pseudonym is fine. Leave it empty to use your username.
        </p>
      </div>

      {state.error && (
        <p role="alert" className="error">
          {state.error}
          {state.suggestions && state.suggestions.length > 0 && (
            <> Try {state.suggestions.join(", ")}.</>
          )}
        </p>
      )}

      <button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}
