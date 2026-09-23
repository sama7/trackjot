import { expect, test, type Browser, type Page } from "@playwright/test";
import { chooseUsername, signUp, testEmail, testUsername } from "./support/auth";
import { clerkUserStatus, testDb } from "./support/backend";
import { CN_TOWER, writeNote } from "./support/notes";

/**
 * Joining and leaving, with real accounts on the Clerk development instance.
 *
 * Joining: a username is required before anything else, a taken one is refused
 * with free alternatives, and picking one of those works.
 *
 * Leaving: the account's rows are gone from the database, the Clerk identity is
 * gone from Clerk (asked of Clerk's own API, not inferred from our UI), and the
 * browser is signed out — the bug this replaces deleted the rows, left the
 * session alive, and put the person straight back inside a fresh empty account.
 */

const target = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const isLocal = target.includes("localhost") || target.includes("127.0.0.1");

test.skip(!isLocal, "Creates and deletes users, so local disposable databases only.");
test.describe.configure({ mode: "serial", timeout: 180_000 });

async function freshPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

let taken: string;

test("a new account cannot get past choosing a username", async ({ browser }) => {
  // Somebody already holds a name.
  const first = await freshPage(browser);
  taken = testUsername("held");
  await signUp(first, testEmail("holder"), { username: taken });
  await first.context().close();

  const page = await freshPage(browser);
  await signUp(page, testEmail("joiner"), { stopAtWelcome: true });

  // Going around the step is not possible.
  for (const path of ["/notes", "/collections", "/account"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/welcome\?next=/);
  }

  // The taken name is refused as you type, with free alternatives offered.
  const field = page.getByLabel(/^username$/i);
  await field.fill(taken.toUpperCase());
  await expect(page.getByText(/someone already has that one/i)).toBeVisible({ timeout: 15_000 });
  const suggestion = page.locator("button.suggestion-chip").first();
  await expect(suggestion).toBeVisible();
  const picked = (await suggestion.textContent())!.trim();
  await suggestion.click();
  await expect(field).toHaveValue(picked);
  await expect(page.getByText(`${picked} is available`)).toBeVisible({ timeout: 15_000 });

  await page.getByLabel(/display name/i).fill("  A   Pseudonym  ");
  await page.getByRole("button", { name: /^continue$/i }).click();
  await expect(page).toHaveURL(/\/account/, { timeout: 30_000 });

  await expect(page.locator(".username-current").first()).toHaveText(picked);
  await expect(page.locator(".username-current").nth(1)).toHaveText("A Pseudonym");
  await page.context().close();
});

test("the submit re-checks, so a name taken in the meantime is still refused", async ({ browser }) => {
  const page = await freshPage(browser);
  await signUp(page, testEmail("racer"), { stopAtWelcome: true });
  // Type-and-submit without waiting for the live check: the server decides.
  await chooseUsername(page, taken);
  // Scoped to the form: Next.js renders its own route announcer with
  // role="alert", so a page-wide alert query trips strict mode.
  await expect(page.locator("form [role='alert']")).toContainText(/someone already has that one/i, {
    timeout: 15_000,
  });
  await expect(page).toHaveURL(/\/welcome/);
  await page.context().close();
});

test("deleting an account removes the data and the sign-in, and signs you out", async ({
  browser,
}) => {
  const page = await freshPage(browser);
  const username = testUsername("leaver");
  await signUp(page, testEmail("leaver"), { username });
  await writeNote(page, { ...CN_TOWER, body: "about to be deleted" });

  const db = testDb();
  const user = await db.user.findUniqueOrThrow({ where: { username } });
  expect(await db.note.count({ where: { ownerId: user.id } })).toBe(1);
  expect(await clerkUserStatus(user.authSubject)).toBe(200);

  await page.goto("/account");
  await page.getByLabel(/type .* to confirm/i).fill(username);
  await page.getByRole("button", { name: /delete my account/i }).click();

  await expect(page).toHaveURL(/\/\?account=deleted/, { timeout: 30_000 });
  await expect(page.getByText(/has been deleted, and you have been signed out/i)).toBeVisible();

  // Gone from our database…
  expect(await db.user.count({ where: { id: user.id } })).toBe(0);
  expect(await db.note.count({ where: { ownerId: user.id } })).toBe(0);
  // …gone from Clerk…
  expect(await clerkUserStatus(user.authSubject)).toBe(404);
  // …and this browser is no longer signed in, so nothing is silently recreated.
  await page.goto("/notes");
  await expect(page).toHaveURL(/\/sign-in/, { timeout: 30_000 });
  expect(await db.user.count({ where: { authSubject: user.authSubject } })).toBe(0);
  await page.context().close();
});
