"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import type { Visibility } from "@prisma/client";
import { ConfirmButton } from "@/components/confirm-button";
import { CopyButton } from "@/components/copy-button";
import { PreviewPlayer } from "@/components/preview-player";
import { CoverArt } from "@/components/cover-art";
import { describeTimestamps } from "@/lib/format-date";
import type { NoteRowData } from "@/lib/notes/list";
import { ExperiencedFields, PlaceFields } from "./note-fields";
import { TagInput } from "./tag-input";
import { setNoteTagsAction } from "./tag-actions";
import {
  deleteNoteAction,
  previewForNoteAction,
  setNoteVisibilityAction,
  setNoteVisibilityFormAction,
  updateNoteAction,
} from "./actions";

/**
 * One note.
 *
 * It reads as a note by default and only becomes a form when you ask it to. The
 * previous version rendered every note as an always-open `<textarea>` with a
 * Save button under it, so a list of twenty notes was twenty edit boxes.
 *
 * Display honours the per-note override before the shared recording, which is
 * what keeps one user's correction from altering what another user saved.
 */
export function NoteRow({
  note,
  baseUrl,
  allTags,
  allPlaces = [],
}: {
  note: NoteRowData;
  baseUrl: string;
  allTags: string[];
  /** This writer's own previous places, offered as suggestions. */
  allPlaces?: string[];
}) {
  const [editing, setEditing] = useState(false);
  const shareUrl = note.shareToken ? `${baseUrl}/n/${note.shareToken}` : null;

  return (
    <li className="note-card">
      <div className="note-head">
        <CoverArt
          url={note.artworkThumbUrl}
          fullUrl={note.artworkUrl}
          size={56}
          title={note.title}
        />
        <div className="note-head-main">
          <strong>
            {note.collection ? (
              <Link href={`/collections/${note.collection.id}`}>{note.title}</Link>
            ) : (
              note.title
            )}
          </strong>
          {note.artist && <div className="note">{note.artist}</div>}
          {note.albumTitle && <div className="note album">{note.albumTitle}</div>}
          {note.context && (
            <div className="note">
              in <Link href={`/collections/${note.context.id}`}>{note.context.name}</Link>
            </div>
          )}
        </div>
        <span className={`chip ${note.visibility}`}>{note.visibility}</span>
      </div>

      {editing ? (
        <form
          action={async (formData) => {
            await updateNoteAction(note.id, formData);
            await setNoteTagsAction(note.id, formData);
            setEditing(false);
          }}
          className="inline-edit"
        >
          <label htmlFor={`body-${note.id}`} className="visually-hidden">
            Note
          </label>
          <textarea
            id={`body-${note.id}`}
            name="body"
            defaultValue={note.body}
            rows={4}
            autoFocus
          />
          <ExperiencedFields
            idPrefix={note.id}
            experiencedAt={note.experiencedAt}
            precision={note.experiencedPrecision}
          />
          <PlaceFields
            idPrefix={note.id}
            placeLabel={note.placeLabel}
            knownPlaces={allPlaces}
          />
          {/*
            Tags edit here, not behind their own button.
            
            "Edit" and "Add tags" sat side by side as two ways into the same
            card, each opening a different form, so changing a note's wording
            and its tags took two rounds of open-change-save. Tagging is part of
            filing a note, and this is the form for filing a note.
          */}
          <fieldset className="sub-fields">
            <legend>Tags</legend>
            <label htmlFor={`tags-${note.id}`} className="visually-hidden">
              Tags, separated by commas
            </label>
            <TagInput
              id={`tags-${note.id}`}
              name="tags"
              defaultValue={note.tags.join(", ")}
              suggestions={allTags}
            />
          </fieldset>
          <div className="row">
            <button type="submit">Save</button>
            <button type="button" className="linkish" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="note-body">{note.body}</p>
      )}

      <p className="note stamp">
        {note.experiencedLabel && <>Heard {note.experiencedLabel} · </>}
        {note.placeLabel && (
          <>
            {/* Clickable for the same reason a tag is: a place is only worth
                recording if it leads back to everything else that happened
                there. */}
            <Link
              href={`/notes?place=${encodeURIComponent(note.placeLabel)}#notes`}
              className="place"
            >
              {note.placeLabel}
            </Link>{" "}
            ·{" "}
          </>
        )}
        {describeTimestamps(note.createdAt, note.updatedAt)}
      </p>

      {note.tags.length > 0 && !editing && (
        <div className="row tag-list">
          {note.tags.map((name) => (
            <Link
              key={name}
              href={`/notes?tag=${encodeURIComponent(name)}#notes`}
              className="chip tag"
            >
              {name}
            </Link>
          ))}
        </div>
      )}

      {/*
        Three lines, in the order the actions actually get used.
        
        Everything routine sits together on one line; the preview gets its own,
        because expanding it grows a row of five controls and a progress bar
        that would otherwise reflow the links beside it mid-listen; and Delete
        gets its own at the bottom, away from everything reversible. It was
        previously the last item on a wrapping line, which on a phone put "one
        tap and the note is gone" directly beneath whatever happened to wrap.
      */}
      <div className="row actions">
        {!editing && (
          <button type="button" className="linkish" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}

        <VisibilityPicker
          id={note.id}
          visibility={note.visibility}
          action={setNoteVisibilityAction}
          formAction={setNoteVisibilityFormAction}
        />

        {shareUrl && <CopyButton value={shareUrl} label="Copy link" />}

        {note.providerUrl && note.providerName && (
          <a href={note.providerUrl} target="_blank" rel="noopener noreferrer">
            Open in {note.providerName}
          </a>
        )}

      </div>

      {/* Only for notes about a track. A note about a collection has no one
          recording to preview, and offering a play button there would be a
          promise about something that does not exist. */}
      {!note.collection && (
        <div className="row actions note-preview-row">
          <PreviewPlayer
            noteId={note.id}
            title={note.title}
            artist={note.artist}
            artwork={note.artworkUrl ?? note.artworkThumbUrl}
            resolve={previewForNoteAction}
          />
        </div>
      )}

      <div className="row actions note-danger-row">
        <ConfirmButton
          label="Delete"
          title="Delete this note?"
          body={
            <>
              <p>
                <strong>{note.title}</strong>
                {note.artist ? ` — ${note.artist}` : ""}
              </p>
              <blockquote>{note.body}</blockquote>
              <p>This can&rsquo;t be undone.</p>
            </>
          }
          confirmLabel="Delete it"
          formAction={deleteNoteAction.bind(null, note.id)}
        />
      </div>
    </li>
  );
}

/**
 * Who can read this — as one question with three answers.
 *
 * Two separate bugs lived here, and both came from letting the DOM carry the
 * value across a Server Action:
 *
 *   1. **React 19 resets an uncontrolled form after an action completes**, and a
 *      `<select defaultValue>` is restored from the `selected` *attribute* React
 *      set at mount, which never updates. The pill said "unlisted" while the
 *      select snapped back to "private" — and the user then could not choose
 *      private, because the control already claimed to be there.
 *   2. Making it controlled fixed the display and exposed the worse one: React
 *      restores a controlled input's DOM value during the change event, and the
 *      form serialised its FormData *after* that restore. Every change after the
 *      first submitted the previous value, so the write silently did nothing.
 *
 * So the value is held in state and handed to the action as an argument. The
 * form remains only as the no-JS fallback.
 *
 * It applies on change rather than behind a Save button, because a select whose
 * value differs from the saved state is exactly how someone ends up believing
 * they published something they didn't.
 */
export function VisibilityPicker({
  id,
  visibility,
  action,
  formAction,
}: {
  id: string;
  visibility: Visibility;
  action: (id: string, visibility: string) => Promise<void>;
  formAction: (id: string, formData: FormData) => Promise<void>;
}) {
  const [value, setValue] = useState<Visibility>(visibility);
  const [pending, startTransition] = useTransition();

  return (
    <form action={formAction.bind(null, id)} className="visibility">
      <label htmlFor={`vis-${id}`} className="visually-hidden">
        Who can see this
      </label>
      <select
        id={`vis-${id}`}
        name="visibility"
        value={value}
        disabled={pending}
        onChange={(event) => {
          const next = event.currentTarget.value as Visibility;
          setValue(next);
          // The chosen value is passed to the action directly rather than left
          // for the form to serialise. See the comment on the action.
          startTransition(async () => {
            await action(id, next);
          });
        }}
      >
        <option value="private">Private — only you</option>
        <option value="unlisted">Unlisted — anyone with the link</option>
        <option value="public">Public — anyone, may be featured</option>
      </select>
      {/* Without JavaScript the select cannot submit itself, so the form and
          its button remain the fallback — same action, same validation. */}
      <noscript>
        <button type="submit">Update</button>
      </noscript>
    </form>
  );
}
