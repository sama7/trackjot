"use client";

import { useState } from "react";
import Link from "next/link";
import { deleteTagAction, renameTagAction } from "./tag-actions";

/**
 * The tag filter, and the only place tags can be renamed or deleted.
 *
 * Tags had no management at all: they could be typed onto a note and removed
 * from that note, and that was the whole vocabulary. A typo therefore lived
 * forever, and there was no way to merge "late night" into "late-night" short
 * of editing every note that carried either.
 *
 * Rename and delete appear only for the tag currently being filtered on. That
 * keeps a row of twenty tags from becoming a row of sixty controls, and it means
 * you are looking at exactly the notes you are about to affect when you decide.
 */
export function TagBar({
  tags,
  active,
}: {
  tags: Array<{ name: string; count: number }>;
  active: string;
}) {
  const [renaming, setRenaming] = useState(false);
  const current = tags.find((t) => t.name === active);

  if (tags.length === 0) return null;

  return (
    <div className="tag-bar">
      <div className="row tag-list">
        <span className="note">Tags</span>
        {tags.map((t) => (
          <Link
            key={t.name}
            /* `#notes` so filtering scrolls to the list rather than back past
               the listening strip and the capture form to the top of the page. */
            href={t.name === active ? "/notes#notes" : `/notes?tag=${encodeURIComponent(t.name)}#notes`}
            className={`chip tag${t.name === active ? " active" : ""}`}
          >
            {/* No space between: the chip is a flex row and spaces them with
                `gap`, so a literal one would sit on top of that. */}
            {t.name}
            <span className="note">{t.count}</span>
          </Link>
        ))}
      </div>

      {current && (
        <div className="row tag-admin">
          {renaming ? (
            <form
              action={async (formData) => {
                await renameTagAction(current.name, formData);
                setRenaming(false);
              }}
              className="row"
            >
              <label htmlFor="tag-rename" className="visually-hidden">
                New name for “{current.name}”
              </label>
              <input id="tag-rename" name="name" defaultValue={current.name} autoFocus />
              <button type="submit">Rename</button>
              <button type="button" className="linkish" onClick={() => setRenaming(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <>
              <button type="button" className="linkish" onClick={() => setRenaming(true)}>
                Rename “{current.name}”
              </button>
              <form
                action={deleteTagAction.bind(null, current.name)}
                onSubmit={(event) => {
                  if (
                    !confirm(
                      `Remove the tag “${current.name}” from ${current.count} note${
                        current.count === 1 ? "" : "s"
                      }? The notes themselves are kept.`,
                    )
                  ) {
                    event.preventDefault();
                  }
                }}
              >
                <button type="submit" className="linkish danger">
                  Delete tag
                </button>
              </form>
            </>
          )}
          <span className="note">
            Renaming onto a tag you already have merges the two.
          </span>
        </div>
      )}
    </div>
  );
}
