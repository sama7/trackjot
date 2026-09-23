#!/usr/bin/env node
/**
 * Validate the *shape* of a deployed environment file. Never prints a value.
 *
 * This exists because of a silent failure that a smoke test could not catch.
 * The first deployment copied secrets from a local file with `grep`, which is
 * line-based — so the multi-line Apple private key arrived truncated: a BEGIN
 * marker, no END, 94 of 261 bytes. Nothing complained. The app started, served
 * every page, passed every check, and Apple Music was simply broken, because
 * the failure only surfaces inside a signing call that no anonymous request
 * makes.
 *
 * The general lesson is that a secret can be *present* and *wrong*, and
 * presence is all a `[ -n "$VAR" ]` check ever proves. So these rules assert
 * structure: a PEM has both markers, a key has a plausible length, a URL parses.
 *
 * Values are never printed, logged, or included in an error. Failures name the
 * variable and describe the shape that was expected.
 *
 * Usage: node scripts/check-env.mjs [path-to-env]   (default ./.env)
 */

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const path = process.argv[2] ?? ".env";

/**
 * Parses `KEY=value`, including a double-quoted value spanning several physical
 * lines — which is exactly the case that broke, so parsing it correctly here is
 * the point rather than an incidental nicety.
 */
function parseEnv(text) {
  const out = {};
  const re = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"([\s\S]*?)"|'([\s\S]*?)'|(.*))$/gm;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  return out;
}

const isPem = (v) =>
  v.includes("BEGIN PRIVATE KEY") &&
  v.includes("END PRIVATE KEY") &&
  // Real newlines or escaped ones; both are valid on disk.
  (v.includes("\n") || v.includes("\\n")) &&
  v.length > 200;

const isUrl = (v) => {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
};

const isPgUrl = (v) => v.startsWith("postgres://") || v.startsWith("postgresql://");

/** [name, required, predicate, expectation] */
const RULES = [
  ["DATABASE_URL", true, isPgUrl, "a postgres:// or postgresql:// URL"],
  ["DIRECT_URL", false, isPgUrl, "a postgres:// or postgresql:// URL"],
  ["APP_BASE_URL", true, isUrl, "an absolute http(s) URL"],
  [
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
    true,
    (v) => /^pk_(test|live)_/.test(v),
    "a key starting pk_test_ or pk_live_",
  ],
  [
    "CLERK_SECRET_KEY",
    true,
    (v) => /^sk_(test|live)_/.test(v) && v.length > 30,
    "a key starting sk_test_ or sk_live_",
  ],
  ["SPOTIFY_CLIENT_ID", false, (v) => v.length === 32, "32 hex characters"],
  ["SPOTIFY_CLIENT_SECRET", false, (v) => v.length === 32, "32 hex characters"],
  ["APPLE_TEAM_ID", false, (v) => /^[A-Z0-9]{10}$/.test(v), "a 10-character Team ID"],
  ["APPLE_MUSIC_KEY_ID", false, (v) => /^[A-Z0-9]{10}$/.test(v), "a 10-character Key ID"],
  [
    "APPLE_MUSIC_PRIVATE_KEY",
    false,
    isPem,
    "a complete PKCS#8 PEM — BOTH begin and end markers, over 200 bytes",
  ],
  // Optional, as a pair: developer.tidal.com → your app → Client ID / Secret.
  // Absent, Tidal links are recognised and politely refused.
  ["TIDAL_CLIENT_ID", false, (v) => /^[A-Za-z0-9]{8,64}$/.test(v), "the app's Client ID"],
  ["TIDAL_CLIENT_SECRET", false, (v) => /^[A-Za-z0-9+/=_-]{16,128}$/.test(v), "the app's Client Secret"],
  ["TIDAL_COUNTRY_CODE", false, (v) => /^[A-Za-z]{2}$/.test(v), "a two-letter country code, e.g. US"],
  // Optional: its absence is how the Last.fm integration stays feature-flagged
  // off. Present but malformed is the state worth catching, because the feature
  // would then appear in the UI and fail at call time.
  ["LASTFM_API_KEY", false, (v) => /^[0-9a-f]{32}$/i.test(v), "32 hex characters"],
  // Required for the approval flow specifically: without it TrackJot can read
  // public profiles but cannot sign a request, so a user who has hidden their
  // listening cannot connect at all.
  ["LASTFM_SHARED_SECRET", false, (v) => /^[0-9a-f]{32}$/i.test(v), "32 hex characters"],
];

const env = parseEnv(readFileSync(path, "utf8"));
let failed = 0;
let skipped = 0;

console.log(`Checking the shape of ${path} (values are never printed)\n`);

for (const [name, required, ok, expectation] of RULES) {
  const value = env[name];

  if (value === undefined || value === "") {
    if (required) {
      console.log(`  MISSING  ${name.padEnd(34)} required`);
      failed++;
    } else {
      console.log(`  skip     ${name.padEnd(34)} not configured (optional)`);
      skipped++;
    }
    continue;
  }

  if (ok(value)) {
    console.log(`  ok       ${name.padEnd(34)} ${value.length} chars`);
  } else {
    console.log(`  MALFORMED ${name.padEnd(33)} ${value.length} chars — expected ${expectation}`);
    failed++;
  }
}

/**
 * The invite gate fails open when it is asked for without a code. That is the
 * right runtime behaviour — refusing to boot would take the site down over a
 * doormat — but it must never be silent, because "the host is invite-gated"
 * would then be an untrue claim in the place someone would trust it.
 */
if (env.REQUIRE_INVITE_CODE === "true" && !(env.INVITE_CODE ?? "").trim()) {
  console.log(
    "\n  MISCONFIGURED REQUIRE_INVITE_CODE is true but INVITE_CODE is empty. " +
      "The gate is OFF and anyone with the URL can sign up.",
  );
  failed++;
}

/**
 * Apple's three variables are useless individually. A partial set means someone
 * copied some and not others, which is precisely the state the first deployment
 * was left in — and it reads as "Apple is not configured" rather than as the
 * error it is.
 */
/**
 * The Last.fm key alone reads public profiles; the secret is what allows the
 * approval flow. Half a pair is a real state worth naming — the feature appears
 * and then cannot connect anyone whose listening is hidden, which is the exact
 * case it was added for.
 */
if (env.LASTFM_API_KEY && !env.LASTFM_SHARED_SECRET) {
  console.log(
    "\n  PARTIAL    Last.fm: key set, LASTFM_SHARED_SECRET missing. Public profiles will\n" +
      "             work; connecting an account will not.",
  );
}

if (Boolean(env.TIDAL_CLIENT_ID) !== Boolean(env.TIDAL_CLIENT_SECRET)) {
  console.log(
    "\n  INCOMPLETE Tidal: TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET must both be set, or neither.",
  );
  failed++;
}

const apple = ["APPLE_TEAM_ID", "APPLE_MUSIC_KEY_ID", "APPLE_MUSIC_PRIVATE_KEY"];
const present = apple.filter((k) => env[k]);
if (present.length > 0 && present.length < apple.length) {
  console.log(
    `\n  INCOMPLETE Apple Music: ${present.length}/3 set. Missing ${apple
      .filter((k) => !env[k])
      .join(", ")}. Apple features will fail at call time, not at startup.`,
  );
  failed++;
}

/**
 * The publishable key is compiled into the bundle; the secret key is read at
 * runtime. Nothing else in this file can see that they disagree, and disagreeing
 * is catastrophic in a way that looks like nothing: the server starts, health
 * passes, static pages render, and every browser request dies in a Clerk
 * handshake loop with a 500.
 *
 * That is not hypothetical. It shipped on 2026-08-13 because a rebuild sourced
 * the development `.env` while the droplet held the live secret — the exact trap
 * documented three days earlier in the launch checklist.
 *
 * So compare the key ACTUALLY in the build against the one in the environment.
 */
const bundle = ".next/static";
if (existsSync(bundle) && env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
  try {
    const found = execSync(
      `grep -rhoE "pk_(live|test)_[A-Za-z0-9]+" ${bundle} | sort -u`,
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);

    if (found.length === 0) {
      console.log("\n  skip     bundle key                     none found (not a Clerk build?)");
    } else if (found.length > 1) {
      console.log(`\n  MISMATCH bundle contains ${found.length} different publishable keys.`);
      failed++;
    } else if (found[0] !== env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
      const kind = (k) => (k.startsWith("pk_live_") ? "live" : "development");
      console.log(
        `\n  MISMATCH the bundle was built with the ${kind(found[0])} publishable key, ` +
          `but .env holds the ${kind(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)} one.\n` +
          "           Clerk requires a matched pair. Every browser request will fail\n" +
          "           in a handshake loop while health checks keep passing. REBUILD.",
      );
      failed++;
    } else {
      console.log(`\n  ok       bundle key                     matches .env (${found[0].slice(0, 8)}…)`);
    }
  } catch {
    // grep exits non-zero when nothing matches; not a failure on its own.
  }
}

/**
 * The endpoint overrides must never reach a deployment.
 *
 * They exist so CI can point the Last.fm client at a fixture server without a
 * credential. Set on a real host they would send a user's approval — and the
 * session key that comes back — to somebody else's server. Checked in the
 * environment file *and* the process, because either would take effect.
 */
for (const name of ["LASTFM_API_BASE", "LASTFM_AUTH_PAGE"]) {
  if (env[name] || process.env[name]) {
    failed += 1;
    console.log(
      `\n  FAIL     ${name.padEnd(34)} set — this override exists only for the test fixture ` +
        `and must never be set in a deployment`,
    );
  }
}

console.log(
  `\n${failed === 0 ? "All configured variables are well-formed" : `${failed} problem(s)`}` +
    `${skipped ? `, ${skipped} optional not configured` : ""}.`,
);
process.exit(failed === 0 ? 0 : 1);
