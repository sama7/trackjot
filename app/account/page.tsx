import { requireOnboardedUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { DEFAULT_TIME_ZONE, formatDay } from "@/lib/format-date";
import { lastfmAuthConfigured, lastfmConfigured } from "@/lib/music/lastfm/client";
import { LastfmForm } from "./lastfm-form";
import { UsernameForm } from "./username-form";
import { DisplayNameForm } from "./display-name-form";
import { TimeZoneForm } from "./time-zone-form";
import { DangerZone } from "./danger-zone";

/**
 * The account page: who you are here, and how to leave with everything.
 *
 * `requireUser()` derives the acting user from the session alone. Nothing here
 * reads an identifier from the URL or the client — that is the invariant the
 * whole authorization model rests on.
 */
export const dynamic = "force-dynamic";

// Renders as "Account · TrackJot" through the template in app/layout.tsx.
export const metadata = { title: "Account" };

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ lastfm?: string }>;
}) {
  // Set by the Last.fm callback so the page can report what just happened.
  const [{ lastfm: outcome }, user] = await Promise.all([
    searchParams,
    requireOnboardedUser("/account"),
  ]);

  const [notes, collections] = await Promise.all([
    prisma.note.count({ where: { ownerId: user.id } }),
    prisma.collection.count({ where: { ownerId: user.id } }),
  ]);

  return (
    <main>
      <h1>Your account</h1>
      <p className="lede">
        Member since {formatDay(user.createdAt, user.timeZone ?? DEFAULT_TIME_ZONE)} · {notes} note{notes === 1 ? "" : "s"} ·{" "}
        {collections} collection{collections === 1 ? "" : "s"}
      </p>

      <h2>Username</h2>
      <UsernameForm current={user.username} />
      <DisplayNameForm current={user.displayName} />

      <h2>Time zone</h2>
      <TimeZoneForm current={user.timeZone} />

      {/* Feature-flagged on the API key: an unconfigured deployment never
          mentions Last.fm at all. */}
      {lastfmConfigured() && (
        <>
          <h2>Listening history</h2>
          <LastfmForm
            current={user.lastfmUsername}
            authAvailable={lastfmAuthConfigured()}
            outcome={outcome}
          />
        </>
      )}

      <h2>Your notes are yours</h2>
      <p className="note">
        Everything you have written, in whichever form is useful — a spreadsheet, a
        readable document, or the complete record. No request, no waiting, no account
        needed to open the result.
      </p>
      {/*
        Plain links to a route handler rather than buttons: a download needs a
        real response with Content-Disposition, and the browser already knows
        how to do that. `download` is a hint; the header is what decides.
      */}
      <div className="row" style={{ marginTop: "0.75rem" }}>
        <a className="download" href="/account/export?format=json" download>
          Download JSON
        </a>
        <a className="download" href="/account/export?format=csv" download>
          Download CSV
        </a>
        <a className="download" href="/account/export?format=md" download>
          Download Markdown
        </a>
      </div>
      <p className="note">
        JSON is the complete record, including dates, places and tags. CSV opens in a
        spreadsheet. Markdown is for reading, and will still open in thirty years.
      </p>

      <h2>Deleting things</h2>
      <p className="note">
        Deleting a note removes it immediately and permanently — there is no trash to
        empty and no copy kept. Deleting a collection keeps the notes you wrote about its
        tracks; only a note <em>about the collection itself</em> goes with it. Encrypted
        off-site backups exist for disaster recovery and roll off on a schedule; they are
        never used to restore a single deleted note.
      </p>

      <h2>Identity</h2>
      <table>
        <tbody>
          <tr>
            <th scope="row">Local user ID</th>
            <td>
              <code>{user.id}</code>
            </td>
          </tr>
          <tr>
            <th scope="row">Sign-in subject</th>
            <td>
              <code>{user.authSubject}</code>
            </td>
          </tr>
        </tbody>
      </table>
      <p className="note">
        The subject is the external identity. The local UUID is ours, and it is what every
        note and collection is scoped by — so the account survives changing sign-in
        providers.
      </p>
    
      <DangerZone
        username={user.username}
        listeningHistoryAvailable={lastfmConfigured()}
      />
    </main>
  );
}
