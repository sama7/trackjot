import { expect, type Page } from "@playwright/test";

/**
 * Write one note through the capture form's manual tab.
 *
 * Manual entry is used deliberately rather than as a workaround. The link tab
 * calls a provider to resolve what was pasted, so a suite that used it would
 * pass or fail on whether a credential happened to be configured and whether
 * Spotify was reachable — and the independence guarantee (AGENTS.md §1) is
 * precisely that a note can be written with no provider at all. This exercises
 * that path, deterministically and offline.
 *
 * Selectors are pinned to element ids rather than label text. `getByLabel(/your
 * note/i)` matched both the note textarea and the search box ("Search your
 * notes"), which is the sort of ambiguity that grows as a page does.
 */
/**
 * Expand the "Add a note" panel if it is folded.
 *
 * It is collapsed by default — the notes page is mostly read, not written to —
 * so every helper that types into the capture form has to open it first.
 * Idempotent, because some tests arrive with it already open: clicking a
 * `<summary>` toggles, so checking before clicking is the difference between
 * opening it and closing it.
 */
export async function openCapture(page: Page): Promise<void> {
  const panel = page.locator("details.panel").filter({ hasText: "Add a note" }).first();
  await expect(panel).toBeAttached({ timeout: 30_000 });
  if (!(await panel.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await panel.locator("summary").click();
  }
  await expect(panel.locator(".panel-body")).toBeVisible({ timeout: 10_000 });
}

export async function writeNote(
  page: Page,
  note: { link: string; body: string; title: string; artist: string },
): Promise<void> {
  await openCapture(page);
  await page.getByRole("tab", { name: /type it in/i }).click();

  await page.locator("#title").fill(note.title);
  await page.locator("#artistDisplay").fill(note.artist);
  await page.locator("#manual-body").fill(note.body);

  await page.getByRole("button", { name: /save note/i }).click();
  await expect(page.getByText(note.body)).toBeVisible({ timeout: 30_000 });
}

/**
 * Resolve a pasted link and save a note about whatever came back.
 *
 * Only usable where a provider is reachable, which is why the shared helper
 * above does not go through here.
 */
export async function writeNoteFromLink(
  page: Page,
  note: { link: string; body: string },
): Promise<void> {
  await openCapture(page);
  await page.getByRole("tab", { name: /paste a link/i }).click();
  await page.locator("#link").fill(note.link);
  await page.getByRole("button", { name: /look up/i }).click();

  // The note box does not exist until the link has resolved to a track.
  await expect(page.locator("#body")).toBeVisible({ timeout: 30_000 });
  await page.locator("#body").fill(note.body);
  await page.getByRole("button", { name: /save note/i }).click();
}

/** A real Spotify track, used only as a well-formed identifier to parse. */
export const CN_TOWER = {
  link: "https://open.spotify.com/track/4u43I0LP2Xf85OAS85eG0R",
  title: "CN TOWER",
  artist: "PARTYNEXTDOOR & Drake",
};

export const DARLING_I = {
  link: "https://open.spotify.com/track/0VaeksJaXy5R1nvcTMh3Xk",
  title: "Darling, I",
  artist: "Tyler, The Creator",
};

/**
 * Import a two-track collection through the CSV form and land on its page.
 *
 * The collection specs previously skipped themselves whenever no collection
 * happened to exist, which meant the tracklist — the most complex signed-in
 * surface — was never actually checked. CSV is the right way to seed it: it is
 * a real user path, it needs no provider credential, and it is deterministic.
 *
 * The columns are Exportify's, including the URI columns that are the only
 * thing entities are ever created from (AGENTS.md §3b).
 */
export const SMALL_CSV = [
  '"Track URI","Track Name","Artist URI(s)","Artist Name(s)","Album URI","Album Name","Album Artist URI(s)","Album Artist Name(s)","Album Release Date","Track Duration (ms)","Track Number","ISRC"',
  '"spotify:track:4u43I0LP2Xf85OAS85eG0R","CN TOWER","spotify:artist:2HPaUgqeutzr3jx5a9WyDV","PARTYNEXTDOOR","spotify:album:5K79FLRUOSysMtTuAhBXSS","$ome $exy $ongs 4 U","spotify:artist:2HPaUgqeutzr3jx5a9WyDV","PARTYNEXTDOOR","2025-02-14","201000","1","USUG12500001"',
  '"spotify:track:0VaeksJaXy5R1nvcTMh3Xk","Darling, I","spotify:artist:4V8LLVI7PbaPR0K2TGSxFF","Tyler, The Creator","spotify:album:5zi7WsKlIiUXv09tbGLKsE","IGOR","spotify:artist:4V8LLVI7PbaPR0K2TGSxFF","Tyler, The Creator","2019-05-17","239000","2","USQX91900123"',
].join("\n");

export async function importSmallCollection(page: Page): Promise<void> {
  await page.goto("/collections");
  await page.getByRole("group").filter({ hasText: /import from a csv/i }).locator("summary").click();

  await page.locator("#file").setInputFiles({
    name: "august.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(SMALL_CSV, "utf8"),
  });
  await page.locator("#name").fill("August, mostly at night");
  await page.getByRole("button", { name: /^import$/i }).click();

  await page.getByRole("link", { name: /open it/i }).click();
  await expect(page.getByRole("heading", { name: /august, mostly at night/i })).toBeVisible({
    timeout: 30_000,
  });
}
