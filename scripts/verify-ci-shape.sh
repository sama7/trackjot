#!/usr/bin/env bash
#
# Run the browser suite the way CI runs it, not the way this machine does.
#
# Three CI failures in a row came from the same shape of mistake: the local
# environment differs from the runner's, so a green local run proved nothing
# about the thing that was about to go red.
#
#   1. `npm run dev` on 3100 vs the packaged artifact on 3001.
#   2. macOS fonts vs Linux fonts — `sans-serif` is 9-12% wider on a runner, so
#      three placeholders fit here and were clipped there.
#   3. **LASTFM_API_KEY is set in this .env and unset in CI.** Every test gated
#      on "an unconfigured deployment never mentions Last.fm" therefore *skips*
#      locally and runs on the runner. A regression in that copy is invisible
#      here by construction.
#
# This closes the first and the third. The second is handled inside the suite
# itself, which now requires placeholders to fit with headroom rather than
# merely to fit.
#
# Usage: scripts/verify-ci-shape.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3001}"
BASE="http://localhost:${PORT}"

set -a
# shellcheck disable=SC1091
[ -f .env ] && . ./.env
# shellcheck disable=SC1091
[ -f .env.local ] && . ./.env.local
set +a

# The point of the exercise: CI has no Last.fm credentials.
unset LASTFM_API_KEY LASTFM_SHARED_SECRET
# Same reasoning for Tidal: CI holds no Tidal credentials, so neither does this run.
unset TIDAL_CLIENT_ID TIDAL_CLIENT_SECRET TIDAL_COUNTRY_CODE
export APP_BASE_URL="$BASE"

echo "==> Building"
npm run build >/dev/null

echo "==> Packaging"
rm -rf artifact && mkdir -p artifact
cp -r .next/standalone/. artifact/
mkdir -p artifact/.next && cp -r .next/static artifact/.next/static
[ -d public ] && cp -r public artifact/public
mkdir -p artifact/scripts
cp scripts/start-standalone.cjs scripts/smoke.js scripts/check-env.mjs artifact/scripts/
cp -r prisma artifact/prisma

echo "==> Serving on ${PORT}"
if lsof -ti:"$PORT" >/dev/null 2>&1; then kill "$(lsof -ti:"$PORT")"; sleep 1; fi
PORT="$PORT" node artifact/scripts/start-standalone.cjs >/tmp/tj-verify.log 2>&1 &
SERVER=$!
trap 'kill "$SERVER" 2>/dev/null || true; rm -rf artifact' EXIT

for _ in $(seq 1 45); do
  curl -sf -o /dev/null "${BASE}/api/health" && break
  sleep 1
done
curl -sf -o /dev/null "${BASE}/api/health" || { echo "server never became healthy"; tail -20 /tmp/tj-verify.log; exit 1; }

echo "==> Smoke"
node scripts/smoke.js "$BASE"

echo "==> Browser suite (Last.fm unconfigured, as CI's e2e job runs it)"
E2E_BASE_URL="$BASE" npx playwright test

# ---------------------------------------------------------------------------
# Second pass: the same artifact, pointed at a Last.fm fixture.
#
# The first pass proves the product behaves with the integration absent. It
# cannot say anything about the integration being present, which is the half a
# person actually uses — and which green CI never demonstrated, because the
# tests for it skip without credentials. A fixture answers that without one.
# ---------------------------------------------------------------------------
FIXTURE_PORT="${FIXTURE_PORT:-4599}"
echo "==> Starting the Last.fm fixture on ${FIXTURE_PORT}"
node scripts/lastfm-fixture-server.mjs "$FIXTURE_PORT" >/tmp/tj-lastfm-fixture.log 2>&1 &
FIXTURE=$!
trap 'kill "$SERVER" "$FIXTURE" 2>/dev/null || true; rm -rf artifact' EXIT

for _ in $(seq 1 20); do
  curl -sf -o /dev/null "http://127.0.0.1:${FIXTURE_PORT}/?method=user.getinfo&user=x" && break
  sleep 0.5
done

echo "==> Starting a second instance pointed at the fixture"
# A second server on its own port rather than restarting the first: killing and
# rebinding is a race, and in CI it lost — the replacement failed to bind and
# the health check passed against the old, unconfigured process.
LASTFM_PORT="${LASTFM_PORT:-3002}"
LASTFM_BASE="http://localhost:${LASTFM_PORT}"
if lsof -ti:"$LASTFM_PORT" >/dev/null 2>&1; then kill "$(lsof -ti:"$LASTFM_PORT")"; sleep 1; fi

# Deliberate nonsense. The fixture accepts anything, and a real value must
# never be needed here.
PORT="$LASTFM_PORT" \
APP_BASE_URL="$LASTFM_BASE" \
LASTFM_API_KEY="ffffffffffffffffffffffffffffffff" \
LASTFM_SHARED_SECRET="ffffffffffffffffffffffffffffffff" \
LASTFM_API_BASE="http://127.0.0.1:${FIXTURE_PORT}/" \
LASTFM_AUTH_PAGE="http://127.0.0.1:${FIXTURE_PORT}/api/auth/" \
  node artifact/scripts/start-standalone.cjs >/tmp/tj-verify-lastfm.log 2>&1 &
LASTFM_SERVER=$!
trap 'kill "$SERVER" "$FIXTURE" "$LASTFM_SERVER" 2>/dev/null || true; rm -rf artifact' EXIT

for _ in $(seq 1 45); do
  curl -sf -o /dev/null "${LASTFM_BASE}/api/health" && break
  sleep 1
done
curl -sf -o /dev/null "${LASTFM_BASE}/api/health" || { echo "second instance never became healthy"; tail -20 /tmp/tj-verify-lastfm.log; exit 1; }

echo "==> Browser suite (Last.fm connected, against the fixture)"
PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/tj-lastfm-results.json \
E2E_BASE_URL="$LASTFM_BASE" E2E_LASTFM_FIXTURE=1 \
  npx playwright test tests/e2e/lastfm-connected.spec.ts --reporter=line,json
node scripts/assert-suite-ran.mjs /tmp/tj-lastfm-results.json 5

echo "==> CI-shaped verification passed, both configured and not"
