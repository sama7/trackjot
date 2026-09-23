import Link from "next/link";
import { linkProviderNames } from "@/lib/music/link-providers";
import { requireOnboardedUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { CoverArt } from "@/components/cover-art";
import { providerLabel } from "@/lib/notes/list";
import { describeTimestamps, formatDay } from "@/lib/format-date";
import { CsvImportForm } from "./import-form";

export const dynamic = "force-dynamic";

// Renders as "Your collections · TrackJot" through the template in app/layout.tsx.
export const metadata = { title: "Your collections" };

export default async function CollectionsPage() {
  const user = await requireOnboardedUser("/collections");

  const collections = await prisma.collection.findMany({
    where: { ownerId: user.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { items: true } }, import: true },
  });

  const described = collections.map((c) => ({
    ...c,
    when: c.sourceSnapshotAt
      ? `imported ${formatDay(c.sourceSnapshotAt)}`
      : describeTimestamps(c.createdAt, c.updatedAt).toLowerCase(),
  }));

  return (
    <main>
      <header className="page-head">
        <div>
          <h1>Your collections</h1>
          <p className="lede">
            Imported from a link or a CSV. A collection can be refreshed from its source
            later — notes follow their track, and anything that loses its track is kept.
          </p>
        </div>
      </header>

      <CsvImportForm collections={collections.map((c) => ({ id: c.id, name: c.name }))} />

      {collections.length === 0 ? (
        <p className="note" style={{ marginTop: "1.5rem" }}>
          Nothing yet. Paste a {linkProviderNames()} album or playlist link on the{" "}
          <Link href="/notes">notes page</Link> and the whole thing comes across — or
          import a CSV above.
        </p>
      ) : (
        <ul className="notes" style={{ marginTop: "1.5rem" }}>
          {described.map((c) => (
            <li key={c.id} className="note-card">
              <div className="note-head">
                <CoverArt url={c.artworkThumbUrl} size={56} />
                <div className="note-head-main">
                  <strong>
                    <Link href={`/collections/${c.id}`}>{c.name}</Link>
                  </strong>
                  <div className="note">
                    {c._count.items} track{c._count.items === 1 ? "" : "s"} · {c.when}
                  </div>
                  {c.description && <p className="note">{c.description}</p>}
                </div>
                <span className={`chip ${c.visibility}`}>{c.visibility}</span>
              </div>
              {c.sourceUrl && providerLabel(c.sourceProvider) && (
                <p className="note">
                  <a href={c.sourceUrl} target="_blank" rel="noopener noreferrer">
                    Open in {providerLabel(c.sourceProvider)}
                  </a>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
