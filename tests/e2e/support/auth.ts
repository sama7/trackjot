import { setupClerkTestingToken } from "@clerk/testing/playwright";
import type { Page } from "@playwright/test";

/**
 * Signing in a test user through the real sign-in UI.
 *
 * Deliberately through the UI rather than by injecting a session cookie. The
 * thing most likely to break in an auth integration is the wiring between the
 * provider's component, the proxy gate, and the lazy local-user upsert — and a
 * cookie shortcut skips exactly that. It is slower and worth it.
 *
 * Clerk development instances reserve any address containing `+clerk_test` for
 * testing: no email is sent and the verification code is always `424242`. So
 * these accounts are real Clerk users but cost nothing and reach no inbox.
 *
 * `setupClerkTestingToken` suppresses the bot protection that would otherwise
 * challenge an automated browser.
 */

export const TEST_CODE = "424242";

/** Distinct address per run, so parallel workers never share an account. */
export function testEmail(label: string): string {
  return `tj_${label}_${Date.now()}_${Math.floor(Math.random() * 10_000)}+clerk_test@example.com`;
}

/**
 * Returns the username the new account chose, so a spec can find its own rows.
 * `stopAtWelcome` leaves the browser on the username step for specs about it.
 */
export async function signUp(
  page: Page,
  email: string,
  options: { username?: string; stopAtWelcome?: boolean } = {},
): Promise<string | null> {
  await setupClerkTestingToken({ page });

  await page.goto("/sign-up");
  await page.getByRole("textbox", { name: /email/i }).fill(email);
  // EXACT match. A loose /continue/ also matches "Continue with Google" and
  // walks the test straight into Google's OAuth page.
  await page.getByRole("button", { name: /^continue$/i }).first().click();

  await fillCode(page);
  if (options.stopAtWelcome) {
    await page.waitForURL((url) => !/\/sign-(in|up)/.test(url.pathname), { timeout: 30_000 });
    await page.goto("/notes");
    await page.waitForURL(/\/welcome/, { timeout: 30_000 });
    return null;
  }
  return landOnNotes(page, options.username);
}

export async function signIn(page: Page, email: string): Promise<void> {
  await setupClerkTestingToken({ page });

  await page.goto("/sign-in");
  await page.getByRole("textbox", { name: /email/i }).fill(email);
  // See signUp: exact, or this clicks "Continue with Google".
  await page.getByRole("button", { name: /^continue$/i }).first().click();

  await fillCode(page);
  await landOnNotes(page);
}

/**
 * Wait for the signed-in state, then go to the notes page.
 *
 * Clerk's own fallback redirect decides where verification lands — currently
 * `/account`, which is a configuration value rather than something a test
 * should assert. So this waits for *any* page that is no longer part of the
 * auth flow and then navigates explicitly. Reaching /notes without being
 * bounced is itself the proof that the proxy gate accepted the session and the
 * lazy local-user upsert completed.
 */
async function landOnNotes(page: Page, username?: string): Promise<string | null> {
  await page.waitForURL((url) => !/\/sign-(in|up)/.test(url.pathname), { timeout: 30_000 });
  await page.goto("/notes");
  await page.waitForURL(/\/(notes|welcome)/, { timeout: 30_000 });
  let chosen: string | null = null;
  if (new URL(page.url()).pathname === "/welcome") chosen = await chooseUsername(page, username);
  await page.waitForURL(/\/notes/, { timeout: 30_000 });
  return chosen;
}

/** Distinct per call, and inside the 3–30 character rule. */
export function testUsername(label = "t"): string {
  return `${label}_${Date.now().toString(36)}${Math.floor(Math.random() * 1_000)}`.slice(0, 30);
}

/**
 * A new account must choose a username before anything else — every signed-in
 * page sends it to `/welcome` until it has one. Filled explicitly rather than
 * accepting the suggestion, so a test never depends on what was derived from
 * its email address.
 */
export async function chooseUsername(page: Page, username = testUsername()): Promise<string> {
  await page.getByLabel(/^username$/i).fill(username);
  await page.getByRole("button", { name: /^continue$/i }).click();
  return username;
}

/**
 * Clerk renders the code either as one field or as six single-character boxes
 * depending on version and configuration, so both are handled rather than
 * pinned to whichever shipped today.
 */
async function fillCode(page: Page): Promise<void> {
  const boxes = page.locator(
    'input[autocomplete="one-time-code"], input[data-otp-input], input[name="code"], input[inputmode="numeric"]',
  );
  await boxes.first().waitFor({ state: "visible", timeout: 30_000 });

  /**
   * The input renders BEFORE Clerk has finished preparing the verification, and
   * typing into that gap is rejected with "You need to send a verification code
   * before attempting to verify" — which reads like a wrong code rather than a
   * race, and cost an hour to recognise.
   *
   * There is no reliable rendered signal for "prepare finished": the resend
   * countdown appears immediately either way. So this settles briefly, then
   * retries once if the race message shows up. Retrying is what makes it
   * robust; the sleep alone would just move the flake around.
   */
  const type = async () => {
    const count = await boxes.count();
    if (count > 1) {
      for (let i = 0; i < Math.min(count, TEST_CODE.length); i++) {
        await boxes.nth(i).fill(TEST_CODE[i]!);
      }
    } else {
      await boxes.first().fill(TEST_CODE);
    }
  };

  await page.waitForTimeout(3_000);
  await type();

  const raced = await page
    .getByText(/need to send a verification code/i)
    .first()
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);

  if (raced) {
    await page.waitForTimeout(3_000);
    await type();
  }

  /**
   * Clerk submits on the last character, so the usual case needs no click, and
   * clicking anyway races the navigation it just triggered. Only press Continue
   * if we are still on the verification step.
   */
  const left = await page
    .waitForURL((url) => !/verify/.test(url.pathname), { timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (!left) {
    const submit = page.getByRole("button", { name: /^(continue|verify)$/i }).first();
    if (await submit.isVisible().catch(() => false)) {
      await submit.click().catch(() => {});
    }
  }
}
