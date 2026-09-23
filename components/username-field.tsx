"use client";

import { useEffect, useRef, useState } from "react";
import type { UsernameCheck } from "@/lib/users/username";

/**
 * A username input that says, as you type, whether the name is free.
 *
 * Checked on a short pause rather than on every keystroke, and only the answer
 * for the value still in the box is ever shown — a slow reply for "sama" must
 * not arrive after you have typed "samah" and tell you something about a name
 * you have already moved past.
 *
 * When a name is taken, a few that are known to be free are offered as buttons.
 * A bare "taken" leaves someone guessing variations one submit at a time.
 *
 * The server still decides: this is advice, and the unique index settles the
 * race where two people pick the same name in the same second.
 */
export function UsernameField({
  defaultValue,
  check,
  describedBy,
  autoFocus,
}: {
  defaultValue: string;
  check: (raw: string) => Promise<UsernameCheck>;
  describedBy?: string;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState(defaultValue);
  const [result, setResult] = useState<(UsernameCheck & { for: string }) | null>(null);
  const latest = useRef(value);

  useEffect(() => {
    latest.current = value;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    const timer = window.setTimeout(() => {
      check(trimmed).then(
        (answer) => {
          if (latest.current.trim() === trimmed) setResult({ ...answer, for: trimmed });
        },
        () => {
          // A failed check is not a verdict; the submit will still be validated.
        },
      );
    }, 350);
    return () => window.clearTimeout(timer);
  }, [value, check]);

  const shown = result && result.for === value.trim() ? result : null;
  const statusId = "username-status";

  return (
    <>
      <input
        id="username"
        name="username"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoFocus={autoFocus}
        aria-describedby={[describedBy, statusId].filter(Boolean).join(" ")}
        aria-invalid={shown ? !shown.available : undefined}
        required
      />
      <p id={statusId} className="note hint" aria-live="polite">
        {shown?.available && <span className="username-free">✓ {value.trim().toLowerCase()} is available</span>}
        {shown && !shown.available && <span className="error-text">{shown.message}</span>}
      </p>
      {shown && !shown.available && shown.suggestions.length > 0 && (
        <div className="row username-suggestions">
          <span className="note">Free:</span>
          {shown.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="chip suggestion-chip"
              onClick={() => setValue(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
