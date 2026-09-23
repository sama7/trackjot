"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Provider } from "@prisma/client";
import { requireUser } from "@/lib/auth";
import { previewLink, type LinkPreview } from "@/lib/music/preview-link";
import { captureFromProviderRef } from "@/lib/music/capture-track";
import { importFromSpotifyLink } from "@/lib/music/import-from-link";
import { importFromAppleLink } from "@/lib/music/import-from-apple";
import { importFromTidalLink } from "@/lib/music/import-from-tidal";
import { createUserAuthoredRecording } from "@/lib/music/resolve-recording";
import { createNote } from "@/lib/notes/service";

/**
 * Capture in two deliberate steps: look, then write.
 *
 * The old single-shot form asked for a note before it knew what had been
 * pasted. A playlist link therefore offered a note box that could never be
 * saved, and a track link asked for a title the provider was about to supply.
 * These actions split that apart — `lookUpLink` creates nothing, and only the
 * follow-up actions write.
 */

export interface LookupState {
  preview?: LinkPreview;
  /** Echoed back so the field keeps what was typed. */
  link?: string;
  error?: string;
}

export async function lookUpLink(
  _previous: LookupState,
  formData: FormData,
): Promise<LookupState> {
  await requireUser();
  const link = String(formData.get("link") ?? "").trim();
  if (!link) return { error: "Paste a link first." };

  const preview = await previewLink(link);
  if (preview.kind === "unsupported" || preview.kind === "unavailable") {
    return { link, error: preview.message };
  }
  return { link, preview };
}

export interface SaveState {
  error?: string;
  /** True once the note is written, so the form can stand down. */
  saved?: boolean;
  /** Echoed back on failure so nothing typed is lost. */
  body?: string;
  values?: { title: string; artistDisplay: string };
}

/**
 * Save a note about a previewed track.
 *
 * The provider identity comes from hidden fields, and that is safe for a
 * specific reason: the recording is re-resolved from the provider ID rather
 * than trusted from the form. A forged title would be discarded — the worst a
 * tampered field can do is name a different real track.
 */
export async function saveNoteForTrack(
  _previous: SaveState,
  formData: FormData,
): Promise<SaveState> {
  const user = await requireUser();

  const body = String(formData.get("body") ?? "").trim();
  const provider = String(formData.get("provider") ?? "") as Provider;
  const providerId = String(formData.get("providerId") ?? "").trim();

  if (!body) return { error: "Write something about the track first." };
  if (!providerId || !(provider in Provider)) {
    return { error: "Something went wrong reading that track. Paste the link again.", body };
  }

  const capture = await captureFromProviderRef(provider, providerId);
  if (!capture.ok) return { error: capture.message, body };

  try {
    await createNote(user.id, { recordingId: capture.recording.id, body });
  } catch {
    return { error: "Something went wrong saving that note.", body };
  }

  revalidatePath("/notes");
  return { saved: true };
}

/** Manual entry, for music no provider has. */
export async function saveManualNote(
  _previous: SaveState,
  formData: FormData,
): Promise<SaveState> {
  const user = await requireUser();

  const title = String(formData.get("title") ?? "").trim();
  const artistDisplay = String(formData.get("artistDisplay") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  const values = { title, artistDisplay };

  if (!title || !artistDisplay) {
    return { error: "A title and an artist are both needed.", body, values };
  }
  if (!body) return { error: "Write something about the track first.", body, values };

  const { recording } = await createUserAuthoredRecording({
    ownerId: user.id,
    title,
    artistDisplay,
  });

  try {
    await createNote(user.id, { recordingId: recording.id, body });
  } catch {
    return { error: "Something went wrong saving that note.", body, values };
  }

  revalidatePath("/notes");
  return { saved: true };
}

/**
 * Import a previewed collection, then go straight to it.
 *
 * The redirect is the point: a collection is not finished when it is created —
 * it is finished when its tracks have been annotated, and that happens on its
 * own page.
 */
export async function createCollectionFromPreview(formData: FormData): Promise<void> {
  const user = await requireUser();
  const link = String(formData.get("link") ?? "").trim();
  const provider = String(formData.get("provider") ?? "");

  const result =
    provider === Provider.apple_music
      ? await importFromAppleLink(user.id, link)
      : provider === Provider.tidal
        ? await importFromTidalLink(user.id, link)
        : await importFromSpotifyLink(user.id, link);

  if (!result.ok) {
    redirect(`/notes?importError=${encodeURIComponent(result.message)}`);
  }

  revalidatePath("/collections");
  redirect(`/collections/${result.summary.collectionId}`);
}
