"use client";

import { useEffect, useRef } from "react";

/**
 * A section of the page that can be folded away, and stays folded.
 *
 * ## Why
 *
 * The notes page had grown into one long scroll: a listening strip, a capture
 * form, a search bar, a tag row, then the notes — four tools stacked above the
 * thing the page is actually for. Nothing said where one ended and the next
 * began, so on a phone the archive started well below the fold every visit.
 *
 * The tools fold; the notes never do. That asymmetry is the whole design: a
 * tool is something you reach for occasionally, and an archive is what you came
 * to read.
 *
 * ## Why the state is remembered, and where
 *
 * Someone who never connects Last.fm should not close that strip every single
 * time. The preference is per-device rather than per-account because it is
 * about this screen — a phone wants the strip closed far more often than a
 * laptop does — and because a server round trip to record "I folded a panel"
 * would be absurd.
 *
 * `localStorage` is read in an effect rather than during render. Reading it
 * while rendering would make the server's HTML and the browser's first paint
 * disagree, and React would discard the tree; the cost of doing it correctly is
 * that a panel briefly shows its default state, which is why the default is the
 * useful one rather than the tidy one.
 */
export function Panel({
  title,
  summaryNote,
  storageKey,
  defaultOpen = true,
  children,
}: {
  title: string;
  /** A count or hint, shown beside the title — "10 plays", "from Last.fm". */
  summaryNote?: string;
  /** Omit to make the panel forget its state between visits. */
  storageKey?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const panel = useRef<HTMLDetailsElement>(null);
  /**
   * Whether the stored preference has been applied. Until it has, `onToggle`
   * must not write: React's own mount sets `open` from the default, and
   * persisting *that* would overwrite the choice this is about to restore.
   */
  const restored = useRef(false);

  /**
   * The stored state is applied to the DOM directly rather than through
   * `useState`.
   *
   * Setting state in an effect to restore a preference is the cascading-render
   * pattern the React lint rule exists to catch: the tree renders once with the
   * default, then again with the stored value, for a value React never needed
   * to own. `<details>` already holds this state itself — it is an uncontrolled
   * element — so the honest thing is to set the property and let the element
   * keep being the source of truth.
   */
  useEffect(() => {
    if (!storageKey) {
      restored.current = true;
      return;
    }
    try {
      const stored = window.localStorage.getItem(`tj.panel.${storageKey}`);
      if (panel.current && (stored === "open" || stored === "closed")) {
        panel.current.open = stored === "open";
      }
    } catch {
      // Private mode, or site data blocked. The default is a fine answer.
    }
    restored.current = true;
  }, [storageKey]);

  function remember(event: React.SyntheticEvent<HTMLDetailsElement>) {
    if (!storageKey || !restored.current) return;
    try {
      window.localStorage.setItem(
        `tj.panel.${storageKey}`,
        event.currentTarget.open ? "open" : "closed",
      );
    } catch {
      // Nothing to do, and nothing worth telling anyone about.
    }
  }

  return (
    <details ref={panel} className="panel" open={defaultOpen} onToggle={remember}>
      <summary>
        {/* Title and note share one box so that when the note wraps onto its
            own line it lands under the title, not under the chevron. */}
        <span className="panel-heading">
          <span className="panel-title">{title}</span>
          {summaryNote && <span className="note panel-note">{summaryNote}</span>}
        </span>
      </summary>
      <div className="panel-body">{children}</div>
    </details>
  );
}
