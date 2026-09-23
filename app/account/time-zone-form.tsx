"use client";

import { useState, useSyncExternalStore } from "react";
import { timeZoneOptions } from "@/lib/time-zones";
import { setTimeZoneAction } from "./actions";

/**
 * The zone this account reads and writes times in.
 *
 * Every timestamp is stored as an instant; this decides how one is rendered and
 * how a calendar-day filter is bounded. Both mattered before it existed: the
 * product showed New York time to everybody, and a listen at 11pm on the 8th in
 * New York was excluded by a filter for the 8th because the bounds were UTC.
 *
 * The browser's own guess is offered as the first option rather than imposed.
 * `Intl` knows the device's zone, which is almost always right and occasionally
 * very wrong — a VPN, a borrowed laptop, a phone that never left airplane mode
 * — and this is a setting about where the writer lives, not where their
 * hardware thinks it is.
 */
export function TimeZoneForm({ current }: { current: string | null }) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * The device's zone, read on the client only.
   *
   * Reading it during render made the server (which runs in UTC) and the
   * browser disagree about the markup, so React had to throw the server's
   * version away. The server snapshot is "unknown", and the browser fills it in.
   */
  const guess = useSyncExternalStore(
    noop,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    () => null,
  );
  const options = timeZoneOptions([current, guess]);

  async function save(formData: FormData) {
    setSaving(true);
    setError(null);
    try {
      const result = await setTimeZoneAction(formData);
      if (result.error) setError(result.error);
      else setSaved(result.saved ?? null);
    } catch {
      setError("That didn’t save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form action={save} className="capture">
      <div className="field">
        <label htmlFor="timeZone">Time zone</label>
        <select
          id="timeZone"
          name="timeZone"
          defaultValue={current ?? guess ?? "America/New_York"}
          key={current ?? guess ?? "none"}
          aria-describedby="hint-tz"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.value === guess ? `${option.label} — this device` : option.label}
            </option>
          ))}
        </select>
        <p id="hint-tz" className="note hint">
          Used for the times shown on your notes and for date filters. Changing it
          never changes when anything happened — only how it reads.
        </p>
      </div>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="success">
          Times now read in <strong>{saved}</strong>.
        </p>
      )}

      <button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save time zone"}
      </button>
    </form>
  );
}

function noop(): () => void {
  return () => {};
}
