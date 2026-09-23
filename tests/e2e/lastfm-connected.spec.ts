import { expect, test, type Page } from "@playwright/test";
import { signUp, testEmail } from "./support/auth";
import { testDb } from "./support/backend";

/**
 * The connected Last.fm experience, end to end, against a fixture.
 *
 * ## Why this spec exists
 *
 * Green CI did not demonstrate this feature at all. The browser tests for it
 * are gated on the integration being configured, CI holds no Last.fm
 * credentials, and so every one of them skipped — meaning the part of the
 * product a person actually touches was verified by hand or not at all. That is
 * the gap this closes.
 *
 * ## Why a fixture and not a key
 *
 * Handing CI a real API key would make the suite depend on a third party's
 * uptime, on one real account's listening, and on rows that change between
 * runs, so a red build would mean "Last.fm changed" as often as "we broke
 * something". The point of a test is to fail for exactly one reason.
 *
 * `scripts/lastfm-fixture-server.mjs` answers in Last.fm's own shapes with
 * fixed data, and the app is pointed at it with `LASTFM_API_BASE` /
 * `LASTFM_AUTH_PAGE`. **No credential is involved and none should be added.**
 *
 * ## What is covered
 *
 * Capture, a failed save keeping the writing, a retry producing one note rather
 * than two, repeated plays of one track staying separate, and editing the date
 * of an imported jot — the five things that go wrong quietly.
 */

const target = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const isLocal = target.includes("localhost") || target.includes("127.0.0.1");

test.skip(!isLocal, "Creates users, so local disposable databases only.");
test.skip(
  process.env.E2E_LASTFM_FIXTURE !== "1",
  "Needs the server pointed at the Last.fm fixture — see scripts/verify-ci-shape.sh.",
);

// Serial, sharing one account: each sign-up is a real Clerk round trip, and
// running five in parallel is what made an earlier run fail on the
// one-time-code step rather than on anything under test.
test.describe.configure({ mode: "serial", timeout: 180_000 });

let page: Page;
let username: string | null = null;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  username = await signUp(page, testEmail("lastfm-fixture"));

  // Walk the real approval round trip. The fixture's auth page redirects
  // straight back with a token, which is what a person pressing "Yes, allow
  // access" causes — so the state cookie, the callback guard and the session
  // exchange are all genuinely exercised.
  await page.goto("/api/lastfm/start");

  /**
   * Assert the *outcome*, not merely that we landed somewhere.
   *
   * The callback always redirects to `/account?lastfm=…`, success or failure —
   * `connected`, or `state` for a rejected CSRF check, `denied` for a missing
   * token, `failed` when the session exchange itself fell over. The first
   * version of this waited for `/(account|notes)/`, which every one of those
   * satisfies, so a connection that never happened surfaced two tests later as
   * "no rows in the strip" and said nothing about which of four things broke.
   */
  await expect(page).toHaveURL(/\/account\?lastfm=/, { timeout: 30_000 });
  const outcome = new URL(page.url()).searchParams.get("lastfm");
  expect(
    outcome,
    `the Last.fm approval round trip ended in "${outcome}" rather than "connected" — ` +
      `"state" is the CSRF cookie, "denied" is a missing token, "failed" is the session exchange`,
  ).toBe("connected");
});

test.afterAll(async () => {
  await page?.close();
});

/** The strip fetches itself after the page paints, so wait for a row. */
async function openNotes(): Promise<void> {
  await page.goto("/notes");
  await expect(page.locator(".scrobble").first()).toBeVisible({
    timeout: 30_000,
  });
}

test("the strip shows what the fixture is playing", async () => {
  await openNotes();

  // A now-playing track carries no timestamp and must be labelled, not dated.
  await expect(page.getByText("Playing now")).toBeVisible();
  await expect(
    page.locator(".scrobble").filter({ hasText: "Rasiya" }),
  ).toBeVisible();
  await expect(
    page.locator(".scrobble").filter({ hasText: "206" }).first(),
  ).toBeVisible();
});

/**
 * Two hearings of one song are two events. Collapsing them would make "how many
 * times have I heard this" unanswerable, which is most of why listens are
 * modelled separately from recordings at all.
 */
test("the same track played twice stays two rows", async () => {
  await openNotes();

  await expect(
    page.locator(".scrobble").filter({ hasText: "206" }),
  ).toHaveCount(2);
});

test("earlier listens are reachable, and are different plays", async () => {
  await openNotes();

  // Scoped to the row, not the page: this track's album is "AMA NACHLE -
  // Single", so a bare text match finds the title and the album and trips
  // strict mode.
  const amaNachle = page.locator(".scrobble").filter({ hasText: "AMA NACHLE" });

  await expect(amaNachle).toHaveCount(0);
  await page.getByRole("button", { name: /show earlier listens/i }).click();

  await expect(amaNachle).toHaveCount(1, { timeout: 30_000 });
  // The first page is still there — asking for earlier listening must not
  // replace what you were looking at.
  await expect(
    page.locator(".scrobble").filter({ hasText: "206" }).first(),
  ).toBeVisible();
});

/**
 * The failure that loses writing.
 *
 * React resets an uncontrolled field once a form action resolves, so a save
 * that came back with an error used to clear the box at exactly the moment the
 * writer was asked to try again — and a *thrown* action additionally left the
 * button stuck on "Saving…" forever, because nothing reset the flag.
 *
 * The Server Action request is aborted to force that throw path. The route is
 * matched narrowly — POSTs carrying Next's action header, and nothing else —
 * because a broad `**\/notes**` pattern also intercepts the navigation and
 * every RSC fetch behind it, which deadlocked the test for three minutes
 * instead of failing it.
 */
test("a failed save keeps the writing and can be retried", async () => {
  await openNotes();

  const row = page.locator(".scrobble").filter({ hasText: "206" }).first();
  // By accessible name, not by the visible label: each row's button reads
  // "Add note about 206 by Joe James": the accessible name contains the
  // visible words, so a screen reader hears which track it belongs to and a
  // voice user saying "Add note" still reaches it.
  await row.getByRole("button", { name: /^add note about /i }).click();

  const box = page.locator("form.scrobble-jot textarea");
  const written = "the horns come in late and it works";
  await box.fill(written);

  let aborted = false;
  const isAction = (route: import("@playwright/test").Route) => {
    const request = route.request();
    return (
      request.method() === "POST" && Boolean(request.headers()["next-action"])
    );
  };

  await page.route("**/*", async (route) => {
    if (!aborted && isAction(route)) {
      aborted = true;
      await route.abort("failed");
      return;
    }
    await route.fallback();
  });

  await page.getByRole("button", { name: /save note/i }).click();

  // Scoped to the form: the page carries other live regions, and an unscoped
  // `getByRole("alert")` trips strict mode on them.
  await expect(page.locator("form.scrobble-jot [role='alert']")).toContainText(
    /didn.t save/i,
    { timeout: 20_000 },
  );
  // The sentence is still there, which is the entire point.
  await expect(box).toHaveValue(written);
  // And the control is usable again rather than stuck mid-save.
  await expect(page.getByRole("button", { name: /save note/i })).toBeEnabled();

  await page.unroute("**/*");
  await page.getByRole("button", { name: /save note/i }).click();

  // Exactly one note: the retry carries the same idempotency key as the
  // attempt that failed. And the strip now points at it, while still offering
  // another — "Jotted" used to be a dead end.
  await expect(
    page.locator(".note-card").filter({ hasText: written }),
  ).toHaveCount(1, {
    timeout: 30_000,
  });

  const jottedRow = page
    .locator(".scrobble")
    .filter({ hasText: "206" })
    .first();
  await expect(
    jottedRow.getByRole("link", { name: /^view note about 206/i }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    jottedRow.getByRole("button", { name: /^add note about 206/i }),
  ).toBeVisible();

  // "View note" opens exactly the notes about this track.
  await jottedRow.getByRole("link", { name: /^view note about 206/i }).click();
  await expect(page).toHaveURL(/[?&]recording=[0-9a-f-]{36}/);
  await expect(page.locator(".note-card")).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator(".note-card").first()).toContainText(written);
});

/**
 * A jot arrives dated to the minute Last.fm reported. Coarsening that is a
 * statement about how much you actually remember, and it used to be discarded
 * unless the day was edited too.
 */
test("an imported jot can be re-dated to a coarser precision", async () => {
  await openNotes();

  const card = page.locator(".note-card").first();
  await card.getByRole("button", { name: /^edit$/i }).click();

  await card.getByLabel(/how sure/i).selectOption("month");
  await card.getByRole("button", { name: /^save$/i }).click();

  // "September 2026" rather than a day and a minute.
  await expect(card.locator(".stamp")).toContainText(/Heard \w+ \d{4}/, {
    timeout: 30_000,
  });
  await expect(card.locator(".stamp")).not.toContainText(/:\d{2}/);
});

/**
 * "Delete unwritten history" removes the plays and keeps the writing.
 *
 * Asserted against the database, not the page: the strip refetches from the
 * source as soon as /notes is opened again, so what the page shows afterwards
 * says nothing about whether the rows were really deleted.
 */
test("deleting unwritten history keeps the listen a note was made from", async () => {
  const db = testDb();
  const user = await db.user.findUniqueOrThrow({ where: { username: username! } });
  const before = await db.listen.count({ where: { ownerId: user.id } });
  const kept = await db.listen.count({ where: { ownerId: user.id, importedAt: { not: null } } });
  expect(kept).toBe(1);
  expect(before).toBeGreaterThan(kept);

  await page.goto("/account");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /delete unwritten history/i }).click();
  await expect(page.locator("form [role='status']").filter({ hasText: /listen/ })).toContainText(
    `Deleted ${before - kept} listen`,
    { timeout: 30_000 },
  );

  expect(await db.listen.count({ where: { ownerId: user.id } })).toBe(kept);
  expect(await db.note.count({ where: { ownerId: user.id } })).toBe(1);
});
