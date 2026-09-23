# Runbook

Operational procedures for TrackJot v2 on the DigitalOcean droplet.

The droplet also runs **MKDb** — pm2 `server` and `mankbot`, nginx on port 3000,
its own PostgreSQL databases, its own certificate, and a weekly crontab. **None
of it is ever modified.** Everything below touches only TrackJot-owned
processes, files, databases, and vhosts.

---

## Layout

| Thing | Where |
| --- | --- |
| Application | `/srv/trackjot/current`, pm2 process `trackjot` |
| Entry point | `scripts/start-standalone.cjs` — **never `server.js` directly** |
| Node | `/opt/node24` (isolated; the system Node stays 18.19.1 for MKDb) |
| Port | `127.0.0.1:3001`, reachable only through nginx |
| nginx vhost | `/etc/nginx/sites-available/trackjot.com` |
| Certificate | Let's Encrypt, `trackjot.com` + `www.trackjot.com`, auto-renewing |
| Database | droplet-local PostgreSQL 16, database and role both `trackjot` |
| Backups | `/var/backups/trackjot/{hourly,daily}` |
| Backup log | `/var/log/tj-backup.log`, last result in `/var/lib/tj-backup/last-status` |

## Last.fm

Optional, and off unless `LASTFM_API_KEY` is set — that absence is the feature
flag, so an unconfigured deployment never mentions the integration.

**Two values, and they do different jobs.** The key alone reads *public*
profiles. `LASTFM_SHARED_SECRET` is what signs requests, and without it nobody
who has enabled Last.fm's "hide recent listening" setting can connect at all —
a public read of such a profile returns HTTP 403 / `error: 17`. Both are on the
same page: <https://www.last.fm/api/accounts>. `check-env.mjs` reports a key
without a secret as PARTIAL rather than letting it look configured.

```bash
ssh root@<droplet> 'printf "LASTFM_API_KEY=%s\nLASTFM_SHARED_SECRET=%s\n" "<key>" "<secret>" >> /srv/trackjot/current/.env'
ssh root@<droplet> 'cd /srv/trackjot/current && /opt/node24/bin/node scripts/check-env.mjs .env'
ssh root@<droplet> 'pm2 restart trackjot --update-env'
```

Both are **server-side only** — neither may become `NEXT_PUBLIC_*`, or it ships
in the browser bundle for anyone to lift. The secret in particular signs
requests on users' behalf.

**One credential pair serves every environment.** The OAuth callback is passed
per request as `cb`, built from `APP_BASE_URL`, so localhost and production
differ only in that variable — no second API account is needed.

## Backfilling cover art

Artwork is captured at **import time**, so anything written before the artwork
columns existed has none — and re-rendering cannot invent it. The identifiers are
stored, which is why it is recoverable:

```bash
npx tsx --env-file=.env scripts/backfill-artwork.ts           # dry run
npx tsx --env-file=.env scripts/backfill-artwork.ts --apply   # write
```

Idempotent (only fills `artwork_url IS NULL`), additive (two URL columns, nothing
else), and safe to interrupt. It fills albums first on purpose: a recording shows
its album's cover when it has none of its own, so that is one provider call per
album rather than one per track.

Against production, reach the droplet-local database through a tunnel rather than
exposing it:

```bash
ssh -fN -L 55432:localhost:5432 root@<droplet>
DATABASE_URL='postgresql://…@localhost:55432/trackjot' \
  npx tsx scripts/backfill-artwork.ts --apply
```

## Deploying

CI builds the artifact; the droplet only runs it. From a clean checkout:

```bash
# The publishable key is pulled FROM THE DROPLET so the bundle cannot disagree
# with the runtime. Never `source .env` for a production build — the local file
# holds the development key, and that combination took the site down on
# 2026-08-13 while every health check stayed green.
RAW=$(ssh root@<droplet> 'grep "^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=" /srv/trackjot/current/.env | cut -d= -f2-')
# The droplet's .env QUOTES its values, so `cut` hands back "pk_live_…" with the
# quotes attached and a bare `pk_live_*` glob rejects a perfectly good key. A
# guard that fails on valid input is worse than no guard: the next person to hit
# it is tempted to skip it, and this one is the last thing standing between a
# development key and production. Strip the quotes, then check.
LIVE_PK=$(printf '%s' "$RAW" | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//')
case "$LIVE_PK" in pk_live_*) ;; *) echo "refusing: not a live key"; exit 1;; esac

APP_BASE_URL=https://trackjot.com NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="$LIVE_PK" npm run build
# package: .next/standalone + .next/static + public + scripts/ + prisma/
# --delete is safe only with BOTH excludes: .env is the live config and the
# .env.bak.* file is the only copy of what it looked like before an edit.
rsync -az --delete --exclude '.env' --exclude '.env.bak.*' artifact/ root@<droplet>:/srv/trackjot/current/
ssh root@<droplet> 'cd /srv/trackjot/current && /opt/node24/bin/node scripts/check-env.mjs .env'
# PIN the CLI to the repo's version. The standalone artifact carries no Prisma
# CLI, so a bare `npx prisma` fetches whatever npm calls latest — on 2026-09-23
# that was an 8.x pre-release, which rejected `migrate deploy` outright.
PRISMA_V=$(node -p "require('./node_modules/prisma/package.json').version")
ssh root@<droplet> "cd /srv/trackjot/current && PATH=/opt/node24/bin:\$PATH npx -y prisma@$PRISMA_V migrate deploy"
ssh root@<droplet> 'pm2 restart trackjot --update-env'
ssh root@<droplet> 'cd /srv/trackjot/current && /opt/node24/bin/node scripts/smoke.js https://trackjot.com'
```

**Take a rollback snapshot first** — `cp -a /srv/trackjot/current /srv/trackjot/previous`
— and check `/var/lib/tj-backup/last-status` is recent before running migrations.

**Smoke is not the last check.** It sends no HTML `Accept` header, so it cannot
see a Clerk handshake loop; that is exactly what it missed during the 2026-08-13
outage. Finish with requests shaped like a browser's, and ideally a real one:

```bash
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
for p in / /invite /about; do
  curl -s -o /dev/null -w "$p %{http_code}\n" -A "$UA" -H 'Accept: text/html' "https://trackjot.com$p"
done
```

**And prove the new bundle is the one being served.** A restarted process and a
green smoke check say the site is up; neither says it is running what was just
copied. Fetch the stylesheet the live HTML references and look for something the
deploy actually changed:

```bash
CSS=$(curl -s -A "$UA" -H 'Accept: text/html' https://trackjot.com/invite \
  | grep -oE '_next/static/chunks/[a-zA-Z0-9._-]+\.css' | sort -u | head -1)
curl -s "https://trackjot.com/$CSS" | grep -o '<a rule this deploy introduced>'
```

CI builds the same artifact and is the preferred source, but downloading it needs
the `gh` CLI, which is **not installed on this machine**. Until it is, the local
build above — with the key read from the droplet and verified by `check-env.mjs`
after the copy — is the equivalent, and the key comparison is what makes it safe.

`check-env.mjs` validates the **shape** of every configured secret, compares the
publishable key **compiled into the bundle** against the one in `.env`, and never
prints a value.

That comparison exists because of an outage on 2026-08-13. A rebuild sourced the
development `.env` while the droplet held the live secret, so the bundle and the
runtime belonged to different Clerk instances. The server started, `/api/health`
passed, the smoke check passed, and every browser request died in a Clerk
handshake loop with a 500. Nothing that looks at the process or the database can
see that; only comparing the two keys can. It exists because of a failure neither the build nor the smoke
test could see: the first deployment copied secrets with `grep`, which is
line-based, so the multi-line Apple private key arrived truncated — a BEGIN
marker, no END, 94 of 261 bytes. The app started, served every page, passed
every check, and Apple Music was quietly broken, because the failure only
surfaces inside a signing call no anonymous request makes. A secret can be
present and wrong, and presence is all an "is it set?" check ever proves.

**Never copy a multi-line secret with `grep` or line-based tools.** Extract the
whole value and pipe it over ssh without displaying it.

`--exclude '.env'` matters: the environment file lives on the droplet at mode
0600 and must never be overwritten by a deploy or copied into the repository.

**Always finish with the smoke check.** A green build and a running process
proved nothing on 2026-08-10 — every rendering route hung for 30 seconds while
pm2 reported `online`.

### Why the entry point is a wrapper

`scripts/start-standalone.cjs` sets `HOSTNAME=localhost` and forces IPv4-first
DNS. Both are required together, and the reasoning is in the file's header. If
the app is ever started with `HOSTNAME=127.0.0.1`, Next proxies every rendering
request to itself and each one hangs for 30 seconds before a 500.

## Backups

Hourly, from `/etc/cron.d/trackjot-backup` at 17 past. Each run dumps the
`trackjot` database, verifies the dump is complete rather than truncated,
gzips it, and encrypts it with AES-256 **before** anything leaves the box. One
copy per UTC day is promoted to `daily/`. Retention is 24 hourly and 30 daily.

```bash
/usr/local/bin/tj-backup.sh          # run one now
cat /var/lib/tj-backup/last-status   # OK/FAILED, timestamp, destination
tail -20 /var/log/tj-backup.log
```

### Restoring

```bash
# Rehearsal — restores into a scratch database, never the live one.
/usr/local/bin/tj-restore.sh /var/backups/trackjot/daily/tj-<date>.sql.gz.enc

# Real recovery, deliberately awkward:
TJ_ALLOW_LIVE=yes /usr/local/bin/tj-restore.sh <archive> trackjot
```

The script refuses to write to `trackjot` without `TJ_ALLOW_LIVE=yes`,
because restoring over production is a decision someone should make on purpose
at 3am while tired.

**Rehearsed 2026-08-11.** A probe row was written, backed up, and recovered into
a scratch database: 17 tables, probe row present. A wrong passphrase was
confirmed to fail with a clear message rather than half-restoring, and the
ciphertext was confirmed to contain no readable SQL.

### Off-host copies — configured 2026-08-11

Backups are mirrored to Google Drive on the `trackjotapp@gmail.com`
account, remote `tjdrive`, path `trackjot-backups/{hourly,daily}`.
`TJ_RCLONE_DEST` is set in `/etc/cron.d/trackjot-backup`, so every
scheduled run uploads. Only ciphertext crosses the wire — Drive never holds a
readable note body.

Two details worth keeping:

- **The remote uses its own Google OAuth client_id and secret, not rclone's
  shared one.** rclone now warns that the shared client_id is being retired
  during 2026; a remote built on it would have stopped working mid-year with a
  confusing auth error. Ours is independent of that deadline.
- **Scope is `drive.file`**, not full `drive`. rclone can only see and modify
  files it created, so a compromised droplet cannot read or delete the rest of
  that account's Drive.

The browser half of OAuth was done on a laptop and the resulting config piped
straight into the droplet over ssh, so the refresh token was never displayed or
stored anywhere else:

```bash
rclone config show tjdrive | ssh root@<droplet> 'cat >> /root/.config/rclone/rclone.conf'
```

**Round trip rehearsed 2026-08-11.** A probe row was written to the live
database, backed up, encrypted, uploaded, then downloaded from Drive into a
directory holding no other copy, decrypted, and restored into a scratch
database — probe row present, 17 tables. That is the whole chain, not just the
upload.

```bash
rclone about tjdrive:                              # quota
rclone ls tjdrive:trackjot-backups            # what is actually stored
rclone lsf tjdrive:trackjot-backups/hourly | sort | tail -1
```

### The passphrase stays on the droplet

`/root/.tj-db-backup-pass`, mode 0600 — renamed from `.pn-db-backup-pass` on
2026-08-13; the passphrase itself is unchanged, so the copy in the password
manager is still correct. **It is not to be deleted** — the hourly
job reads it on every run, and the script fails closed without it.

A second copy lives in the owner's password manager, which was the part that
mattered: the risk was ever having exactly one copy, sitting next to the
backups it decrypts. Do not confuse this with the v1 disaster-recovery
passphrase, which encrypted a single one-off artifact and was correctly deleted
from disk once saved.

## TLS

Certbot renews automatically via its systemd timer. To check:

```bash
certbot certificates
certbot renew --dry-run
```

The vhost is certbot-managed. Do not hand-edit the `# managed by Certbot` lines;
change things through certbot and re-pull the file into `deploy/nginx/`.

`v2.playlistnotes.io` was retired on 2026-08-12 — vhost and certificate deleted.
It was briefly kept as a redirect on the principle that share links are durable,
which turned out not to apply: there were no users, no notes and no links in the
wild. Its GoDaddy A record is harmless and can be removed whenever convenient.

## Health

```bash
curl -s https://trackjot.com/api/health     # {"status":"ok"}
pm2 status
free -h                                            # 2 GB shared with MKDb
curl -s -o /dev/null -w '%{http_code}\n' https://mkdb.co/   # must stay 200
```

`/api/health` runs `SELECT 1`, so it returns 503 when the process is up but the
database is unreachable — the state a bare 200 would hide.

## If the site is down

1. `pm2 status` — is `trackjot` online?
2. `pm2 logs trackjot --lines 50`
3. `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/health` —
   isolates nginx from the app.
4. `nginx -t && systemctl status nginx`
5. `free -h` — the box is 2 GB and shared. The OOM killer is a real suspect;
   check `dmesg -T | grep -i oom`.
6. Roll back by rsyncing the previous artifact and restarting. The database is
   only rolled back deliberately, via the restore procedure above.
