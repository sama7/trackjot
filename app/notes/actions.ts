"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { previewForRecording } from "@/lib/music/preview";
import { DEFAULT_TIME_ZONE, toDateInputValue } from "@/lib/format-date";
import { DatePrecision, PlacePrecision, Visibility } from "@prisma/client";
import {
  NoteNotFoundError,
  deleteNote,
  setNoteVisibility,
  updateNote,
} from "@/lib/notes/service";

/**
 * Server Actions for the note flow.
 *
 * Every one of these calls `requireUser()` and passes the resulting id as the
 * owner. **No action reads a user id from its form data**, and none should:
 * that is precisely how v1's endpoints ended up world-writable.
 *
 * Errors are returned as state rather than thrown, so a failed capture
 * re-renders the form with what the user typed still in it.
 */

/**
 * These are bound directly to `<form action=…>`, so they must resolve to void.
 *
 * A NoteNotFoundError here means the note is gone or was never the caller's —
 * the two are deliberately indistinguishable. Swallowing it and revalidating is
 * the right response: the list re-renders without the note, and a prober learns
 * nothing from the difference.
 */
export async function updateNoteAction(noteId: string, formData: FormData): Promise<void> {
  const user = await requireUser();
  const body = String(formData.get("body") ?? "").trim();
  if (!body) return;

  try {
    await updateNote(user.id, noteId, {
      body,
      ...readJournalFields(formData, user.timeZone ?? DEFAULT_TIME_ZONE),
    });
  } catch (error) {
    if (!(error instanceof NoteNotFoundError)) throw error;
  }

  revalidatePath("/notes");
  revalidatePath("/collections");
}

/**
 * Read the optional "when" and "where" a note can carry.
 *
 * Two details do real work here. The date arrives as `YYYY-MM-DD` from a date
 * input and is **anchored to the first instant of the stated range** — a note
 * marked "that year" is stored as January 1st — because the precision, not the
 * timestamp, is what the product promises to render.
 */
function readJournalFields(formData: FormData, zone: string) {
  const rawDate = String(formData.get("experiencedAt") ?? "").trim();
  const rawPrecision = String(formData.get("experiencedPrecision") ?? "day");
  const precision: DatePrecision =
    rawPrecision === "year" || rawPrecision === "month" ? rawPrecision : DatePrecision.day;

  /**
   * A note imported from a scrobble knows the minute it was heard, and the date
   * input can only express a day. If the day has not been edited, the stored
   * instant is put back untouched — otherwise merely opening the editor and
   * saving would round a known time down to a date, discarding precision the
   * writer never chose to give up.
   */
  const originalIso = String(formData.get("experiencedAtOriginal") ?? "").trim();
  /**
   * Only while the writer is still claiming a *day*.
   *
   * This preserved the stored minute whenever the date input's day was
   * unchanged — which also swallowed a deliberate change of precision. Someone
   * who opened a scrobbled note, chose "That month", and saved got `time` back
   * and their choice silently discarded, because they had not also touched the
   * date. Coarsening a precision is a statement about how much you actually
   * remember, and it is not the form's to overrule.
   */
  if (
    originalIso &&
    String(formData.get("experiencedPrecisionOriginal") ?? "") === "time" &&
    rawPrecision === "day"
  ) {
    const original = new Date(originalIso);
    if (!Number.isNaN(original.getTime()) && toDateInputValue(original, zone) === rawDate) {
      return {
        experiencedAt: original,
        experiencedPrecision: DatePrecision.time,
        ...readPlaceFields(formData),
      };
    }
  }

  let experiencedAt: Date | null = null;
  if (rawDate) {
    const [y, m, d] = rawDate.split("-").map(Number);
    const month = precision === "year" ? 1 : (m ?? 1);
    const day = precision === "day" ? (d ?? 1) : 1;
    // Noon UTC, not midnight: it renders as the intended day in every time zone
    // this product is likely to display, rather than slipping backwards a day
    // west of Greenwich.
    experiencedAt = new Date(Date.UTC(y ?? 1970, month - 1, day, 12));
  }

  return {
    experiencedAt,
    experiencedPrecision: experiencedAt ? precision : null,
    ...readPlaceFields(formData),
  };
}

/**
 * A place is the words the writer typed, and nothing else.
 *
 * The "remember this precisely" checkbox is gone. It set `exact` instead of
 * `area` on a column that nothing read, beside copy that promised coordinates
 * no code path has ever captured — so it changed nothing a reader could observe
 * while implying location capture that does not happen. A control like that is
 * worse than no control.
 *
 * `placePrecision` stays `area` whenever there is a label: the column and its
 * CHECK constraint still exist, the service still refuses coordinates unless
 * something explicitly claims `exact`, and a future "use my current location"
 * would have somewhere honest to say so. Nothing in the UI claims it today.
 */
function readPlaceFields(formData: FormData) {
  const placeLabel = String(formData.get("placeLabel") ?? "").trim() || null;
  return {
    placeLabel,
    placePrecision: placeLabel ? PlacePrecision.area : null,
  };
}

export async function deleteNoteAction(noteId: string): Promise<void> {
  const user = await requireUser();
  try {
    await deleteNote(user.id, noteId);
  } catch (error) {
    if (!(error instanceof NoteNotFoundError)) throw error;
  }
  revalidatePath("/notes");
}

/**
 * One control for who can read a note.
 *
 * It takes the value **as an argument, not as FormData**, and that is a fix for
 * a real bug rather than a style preference. The picker is a controlled select
 * that submitted its own form on change; React restores a controlled input's
 * DOM value during the change event, and the form's FormData was serialised
 * after that restore — so every change after the first submitted the *previous*
 * value and silently did nothing. Passing the chosen value directly removes the
 * DOM from the path entirely.
 *
 * The value is still parsed against the enum here. It arrives from the client,
 * and it decides whether a private note becomes world-readable; an unrecognised
 * value is ignored rather than defaulted, since the safe response is "change
 * nothing".
 */
export async function setNoteVisibilityAction(
  noteId: string,
  requested: string,
): Promise<void> {
  const user = await requireUser();
  if (!isVisibility(requested)) return;

  try {
    await setNoteVisibility(user.id, noteId, requested);
  } catch (error) {
    if (!(error instanceof NoteNotFoundError)) throw error;
  }

  revalidatePath("/notes");
  revalidatePath("/collections");
}

/** The no-JS path: a real form submit, same validation, same action. */
export async function setNoteVisibilityFormAction(
  noteId: string,
  formData: FormData,
): Promise<void> {
  await setNoteVisibilityAction(noteId, String(formData.get("visibility") ?? ""));
}

function isVisibility(value: string): value is Visibility {
  return Object.values(Visibility).includes(value as Visibility);
}

/**
 * A 30-second preview for a note's track, if any provider serves one.
 *
 * Fetched on demand rather than with the list: resolving a preview can mean a
 * call to Apple or Deezer, and a page of fifty notes must not make fifty of
 * them to decide what a button should say. The answer is cached on the
 * external-id row, so this is one round trip per track, ever.
 *
 * **Owner-scoped, like every other read here.** The note id comes from a
 * browser, and while a preview URL is a public CDN link, letting anyone turn a
 * note id into a response that differs for real and fake ids would confirm
 * whether a stranger's note exists. A note that is not yours returns null,
 * exactly as a note with no preview does.
 */
export async function previewForNoteAction(noteId: string): Promise<{ url: string | null }> {
  const user = await requireUser();

  const note = await prisma.note.findFirst({
    where: { id: noteId, ownerId: user.id },
    select: { recordingId: true },
  });
  if (!note?.recordingId) return { url: null };

  return { url: await previewForRecording(note.recordingId) };
}
