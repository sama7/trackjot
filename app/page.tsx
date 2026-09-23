import Link from "next/link";
import { linkProviderNames } from "@/lib/music/link-providers";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { isDeletedIdentity } from "@/lib/auth";
import { SignInButton, SignUpButton } from "@clerk/nextjs";

/**
 * The landing page.
 *
 * It replaces the Checkpoint 1a schema inspector, which listed every recording,
 * collection and note in the database — including other people's private notes —
 * on a route the proxy treats as public. That was correct for a local review of
 * the data model against seeded fiction and became a privacy hole the moment the
 * app was deployed, so it is gone rather than gated.
 *
 * Nothing here reads the database. A landing page that queries on every
 * anonymous request is a free denial-of-service lever, and there is nothing
 * public to count: notes are private by default and the catalog is not a
 * product surface (AGENTS.md §3a).
 */

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ userId }, params] = await Promise.all([auth(), searchParams]);

  // Someone signed in has no use for the pitch; send them to their notes.
  // A token that outlived its deleted account is not a signed-in visitor.
  if (userId && !(await isDeletedIdentity(userId))) redirect("/notes");

  return (
    <main>
      {/* Said once, where a deleted account lands, so the end of an account is
          confirmed rather than inferred from finding yourself signed out. */}
      {params.account === "deleted" && (
        <p role="status" className="success">
          Your account and everything in it has been deleted, and you have been signed out.
        </p>
      )}
      <p className="eyebrow">TrackJot · a private music journal</p>
      <h1>Keep what music means to you.</h1>
      <p className="lede">
        Streaming services know what a track is. They can&rsquo;t know who played it for
        you, where you were, or what you noticed the fourth time through. Paste a
        track and jot that down before it goes.
      </p>

      <div className="row" style={{ margin: "1.5rem 0 2.5rem" }}>
        <SignUpButton mode="modal">
          <button type="button">Create an account</button>
        </SignUpButton>
        <SignInButton mode="modal">
          <button type="button" className="secondary">
            Sign in
          </button>
        </SignInButton>
      </div>

      <section className="pitch">
        <div>
          <h2>One sentence is enough</h2>
          <p className="note">
            Jot describes the effort, not the value. A passing observation is worth
            keeping, and getting it down should take seconds — you can always come
            back and say more.
          </p>
        </div>
        <div>
          <h2>Paste from anywhere</h2>
          <p className="note">
            {linkProviderNames().replace(" or ", " and ")} tracks, albums and public playlists all resolve
            to real recordings with real artists. No streaming login, ever. If a
            link can&rsquo;t be read, type the track in yourself — a note is never
            blocked on metadata.
          </p>
        </div>
        <div>
          <h2>Where it sat matters</h2>
          <p className="note">
            &ldquo;This song&rdquo; and &ldquo;this song, third into that playlist&rdquo;
            aren&rsquo;t the same thought. Notes can hold either.
          </p>
        </div>
        <div>
          <h2>Private until you say otherwise</h2>
          <p className="note">
            Every note starts private. Sharing is deliberate and one item at a time,
            and publishing a collection never publishes the notes inside it.
          </p>
        </div>
        <div>
          <h2>Yours past the provider</h2>
          <p className="note">
            TrackJot owns your account and its own identifiers for the music. Your
            journal doesn&rsquo;t belong to a streaming service and doesn&rsquo;t
            vanish when you leave one.
          </p>
        </div>
        <div>
          <h2>Findable later</h2>
          <p className="note">
            Search covers what you wrote and the track it was about, because people
            look for &ldquo;that Drake note&rdquo; more often than they remember
            their own wording.
          </p>
        </div>
      </section>

      <p className="note landing-foot">
        A personal project by Samah. <Link href="/about">More about it</Link>.
      </p>
    </main>
  );
}
