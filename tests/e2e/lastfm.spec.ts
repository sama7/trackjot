import { expect, test } from "@playwright/test";
import { signUp, testEmail } from "./support/auth";

/**
 * Connecting a Last.fm account, through a real browser.
 *
 * These run with a **dummy** shared secret, which is enough to exercise
 * everything up to the point Last.fm itself is involved: the redirect out, and
 * the CSRF guard on the way back. Signing a real token exchange needs the real
 * secret and is verified by hand.
 *
 * The callback guard is the part worth having a browser test for. It is a
 * login-CSRF defence, the failure is silent, and the consequence — reading a
 * stranger's listening history believing it is yours — is exactly the sort of
 * thing nobody would think to check by clicking around.
 */

const target = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const isLocal = target.includes("localhost") || target.includes("127.0.0.1");

test.skip(!isLocal, "Creates users, so local disposable databases only.");
test.describe.configure({ timeout: 120_000 });

const configured = Boolean(process.env.LASTFM_API_KEY && process.env.LASTFM_SHARED_SECRET);

test.describe("connecting an account", () => {
  test.skip(!configured, "Needs a Last.fm key and secret to be configured.");

  test("sends the user to Last.fm with a callback and sets a state cookie", async ({ page }) => {
    await signUp(page, testEmail("lastfm-start"));

    // Don't actually navigate to Last.fm; inspect the redirect we issue.
    const response = await page.request.get("/api/lastfm/start", { maxRedirects: 0 });
    expect(response.status()).toBe(307);

    const location = new URL(response.headers()["location"]!);
    expect(location.origin + location.pathname).toBe("https://www.last.fm/api/auth/");
    expect(location.searchParams.get("api_key")).toBeTruthy();

    const callback = new URL(location.searchParams.get("cb")!);
    expect(callback.pathname).toBe("/api/lastfm/callback");
    expect(callback.searchParams.get("state")).toBeTruthy();

    // The shared secret must never travel in a URL the browser follows.
    expect(location.toString()).not.toContain(process.env.LASTFM_SHARED_SECRET!);

    const cookie = (await page.context().cookies()).find((c) => c.name === "tj_lastfm_state");
    expect(cookie?.value).toBe(callback.searchParams.get("state"));
    expect(cookie?.httpOnly).toBe(true);
  });

  /**
   * The login-CSRF defence. A callback that did not start here must be refused
   * even though it carries a plausible token.
   */
  test("refuses a callback whose state does not match the cookie", async ({ page }) => {
    await signUp(page, testEmail("lastfm-csrf"));
    await page.request.get("/api/lastfm/start", { maxRedirects: 0 });

    await page.goto("/api/lastfm/callback?token=attacker-token&state=not-the-one");

    await expect(page).toHaveURL(/\/account\?lastfm=state/);
    await expect(page.getByText(/didn.t start here/i)).toBeVisible();
  });

  test("refuses a callback carrying no state at all", async ({ page }) => {
    await signUp(page, testEmail("lastfm-nostate"));
    await page.request.get("/api/lastfm/start", { maxRedirects: 0 });

    await page.goto("/api/lastfm/callback?token=attacker-token");

    await expect(page).toHaveURL(/\/account\?lastfm=state/);
  });

  /** Nothing is connected until Last.fm confirms the exchange. */
  test("connects nothing when the token is not one Last.fm issued", async ({ page }) => {
    await signUp(page, testEmail("lastfm-badtoken"));

    const start = await page.request.get("/api/lastfm/start", { maxRedirects: 0 });
    const state = new URL(
      new URL(start.headers()["location"]!).searchParams.get("cb")!,
    ).searchParams.get("state")!;

    await page.goto(`/api/lastfm/callback?token=not-a-real-token&state=${state}`);

    await expect(page).toHaveURL(/\/account\?lastfm=failed/);
    await expect(page.getByText(/couldn.t complete that/i)).toBeVisible();
    // Still offering to connect means nothing was stored.
    await expect(page.getByRole("link", { name: /connect last\.fm/i })).toBeVisible();
  });

  test("an anonymous visitor cannot start or complete a connection", async ({ browser }) => {
    const anon = await browser.newContext();
    const page = await anon.newPage();

    for (const path of ["/api/lastfm/start", "/api/lastfm/callback?token=x&state=y"]) {
      const response = await page.request.get(path, { maxRedirects: 0 });
      // Either turned away or 404'd — what must not happen is it working.
      expect(response.status()).not.toBe(200);
    }

    await anon.close();
  });

  test("the account page offers the connection and explains what it is not", async ({ page }) => {
    await signUp(page, testEmail("lastfm-account"));
    await page.goto("/account");

    await expect(page.getByRole("heading", { name: /listening history/i })).toBeVisible();
    await expect(page.getByRole("link", { name: /connect last\.fm/i })).toHaveAttribute(
      "href",
      "/api/lastfm/start",
    );
    // The distinction the whole integration rests on, stated to the user.
    await expect(page.getByText(/not.*a way to sign in to trackjot/i)).toBeVisible();
  });
});

/**
 * The strip keeps itself current, and stops dead while someone is writing.
 *
 * **Opt-in, because the strip does not render without a connected Last.fm.** A
 * freshly signed-up test user has nothing to poll for, so these cannot run in
 * CI; gating the whole group on an env var is honest about that and avoids two
 * permanently-skipping tests whose aborts leave stray errors in the report.
 *
 * To run them against an account that has one:
 *
 * ```
 * E2E_LASTFM_ACCOUNT=1 npx playwright test tests/e2e/lastfm.spec.ts
 * ```
 *
 * The *rule* underneath — when to poll, and when a reply that arrived late may
 * be applied — is covered directly and deterministically by
 * `lib/listens/polling.test.ts`, which does run in CI. These add the wiring on
 * top: that the interval exists, and that an open jot box actually stops it.
 */
test.describe("the recently-played strip updates itself", () => {
  test.skip(
    !configured || !process.env.E2E_LASTFM_ACCOUNT,
    "Set E2E_LASTFM_ACCOUNT=1 and sign in as an account with a connected Last.fm.",
  );

  /**
   * Count reads of the recent-listens feed.
   *
   * Scoped to the strip's own action by its response shape rather than to "any
   * POST to /notes" — Clerk fires server actions of its own on this page, and
   * counting those made the first version of this test count to two before the
   * strip had asked for anything.
   */
  async function countPolls(page: import("@playwright/test").Page) {
    const calls = { n: 0 };
    await page.route("**/notes**", async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.headers()["next-action"]) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.text();
      // The strip's action is the one whose reply carries listen rows.
      if (body.includes("sourceRef") || body.includes("importedNoteId")) calls.n += 1;
      await route.fulfill({ response, body });
    });
    return calls;
  }

  /** The strip must actually be on the page, or these assert about nothing. */
  async function requireStrip(page: import("@playwright/test").Page) {
    await expect(
      page.locator("section.scrobbles"),
      "no recently-played strip — is this account's Last.fm connected?",
    ).toBeVisible({ timeout: 15_000 });
  }

  test("polls again without the page being reloaded", async ({ page }) => {
    await signUp(page, testEmail("lastfm-poll"));
    const calls = await countPolls(page);

    await page.clock.install();
    await page.goto("/notes");
    await requireStrip(page);

    await expect.poll(() => calls.n, { timeout: 30_000 }).toBeGreaterThan(0);
    const afterFirst = calls.n;

    /**
     * A fake clock rather than a real wait. The first version slept through a
     * genuine 30-second interval, passed alone, and failed inside the full
     * suite when six workers shared one dev server — and a flaky test is worse
     * than none, because it teaches you to ignore red.
     */
    await page.clock.runFor(65_000);
    await expect.poll(() => calls.n, { timeout: 15_000 }).toBeGreaterThan(afterFirst);
  });

  test("stops polling while a jot is being written, and resumes on cancel", async ({ page }) => {
    await signUp(page, testEmail("lastfm-pause"));
    await page.clock.install();
    await page.goto("/notes");
    await requireStrip(page);

    const jot = page.getByRole("button", { name: /^add note about /i }).first();
    // Only meaningful when there is something to jot.
    await expect(jot, "no scrobbles to write about").toBeVisible({ timeout: 15_000 });

    await jot.click();
    const box = page.locator("textarea").first();
    await expect(box).toBeVisible();
    await box.fill("half a sentence that must survive");

    const calls = await countPolls(page);
    const before = calls.n;

    // Two intervals' worth of time, instantly.
    await page.clock.runFor(65_000);
    expect(calls.n, "the strip polled while a jot was open").toBe(before);
    // The words are still there.
    await expect(box).toHaveValue("half a sentence that must survive");

    await page.getByRole("button", { name: /^cancel$/i }).first().click();
    await expect
      .poll(() => calls.n, { timeout: 20_000, intervals: [1000] })
      .toBeGreaterThan(before);
  });
});
