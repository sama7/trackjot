#!/usr/bin/env node
/**
 * Post-deploy smoke check: does the built artifact actually *serve*?
 *
 * This exists because of a failure the whole unit/integration suite was blind
 * to. Every test passed, `next build` succeeded, the process stayed up and
 * logged "Ready" — and every route that rendered hung for 30 seconds and then
 * 500'd, because Next was proxying requests to itself (see
 * scripts/start-standalone.js). Nothing that runs before a server boots can see
 * that class of bug; only a real request over a real socket can.
 *
 * So the assertions are deliberately about *serving*, not about content:
 *
 *   - a public page renders          (proves rendering works at all)
 *   - a protected page redirects     (proves the proxy gate is wired)
 *   - health reports the database    (proves the pool reaches PostgreSQL)
 *
 * Anonymous requests only. It is safe to point at a deployed environment: it
 * creates nothing, needs no account, and reads no private data.
 *
 * Usage: node scripts/smoke.js [baseUrl]
 */

const BASE = (process.argv[2] || process.env.SMOKE_BASE_URL || "http://127.0.0.1:3001").replace(
  /\/$/,
  "",
);
const TIMEOUT_MS = 15_000;

/**
 * A hang is the signature failure here, so slowness is itself a result, and a
 * rendering page must return a non-empty body — a broken render can still
 * produce a 200 with nothing in it.
 *
 * A gated host redirects the public pages to /invite, and that redirect is
 * itself proof the app is serving — the failure this script exists to catch was
 * a 30-second hang, not a redirect. So a public page may either render or bounce
 * to the gate, and the gate page must render either way. Demanding a 200 on `/`
 * would have made enabling the invite gate look like an outage.
 */
const gateRedirect = (status, location) =>
  (status === 307 || status === 302) && (location ?? "").includes("/invite");

const checks = [
  {
    path: "/",
    expect: (s, len, loc) => (s === 200 && len > 0) || gateRedirect(s, loc),
    describe: "renders, or redirects to the invite gate",
  },
  {
    path: "/sign-in",
    expect: (s, len, loc) => (s === 200 && len > 0) || gateRedirect(s, loc),
    describe: "renders, or redirects to the invite gate",
  },
  {
    path: "/invite",
    // 200 when the gate is on; 307 to / when it is off, since the page then has
    // no reason to exist. Both are correct; a 500 or a hang is not.
    expect: (s) => s === 200 || s === 307,
    describe: "the gate page answers",
  },
  { path: "/api/health", expect: (s) => s === 200, describe: "200 (database reachable)" },
  /**
   * A missing file-like path. The middleware skips these by design, and the
   * shared header used to call a Clerk helper that throws without it — so every
   * bot probe for `/wp-login.html` answered 500 and filled the error log. It
   * must be an ordinary 404.
   */
  {
    path: "/smoke-missing-file.html",
    expect: (s) => s === 404,
    describe: "404 (not a 500 from a page rendered without middleware)",
  },
  {
    path: "/notes",
    expect: (s) => s === 307 || s === 302,
    describe: "redirect (protected route gated)",
  },
];

async function probe(path) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    /**
     * No `Accept: text/html`. A Clerk **development** instance answers document
     * requests that carry no dev-browser cookie with a handshake redirect —
     * correct behaviour, but it would mask whether the page renders, and the
     * handshake target is on Clerk's domain, which a CI runner should not be
     * reaching. The default `Accept` gets the rendered page directly. Production
     * instances do not handshake, so this stays representative there too.
     */
    const response = await fetch(`${BASE}${path}`, {
      redirect: "manual",
      signal: controller.signal,
    });
    const body = await response.text();
    return {
      status: response.status,
      length: body.length,
      location: response.headers.get("location"),
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      status: 0,
      length: 0,
      ms: Date.now() - started,
      error: String(error?.message ?? error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`Smoke testing ${BASE}`);
  let failed = 0;

  for (const check of checks) {
    const { status, length, location, ms, error } = await probe(check.path);
    const ok = check.expect(status, length, location);
    if (!ok) failed++;
    const actual = status === 0 ? `no response (${error})` : `${status} ${length}B`;
    console.log(
      `  ${ok ? "PASS" : "FAIL"}  ${check.path.padEnd(14)} ${String(actual).padEnd(16)} ${ms}ms   expected ${check.describe}`,
    );
  }

  if (failed > 0) {
    console.error(`\n${failed} smoke check(s) failed against ${BASE}.`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
