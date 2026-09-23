import Link from "next/link";
import { trackUrl } from "@/lib/music/provider-url";
import { notFound } from "next/navigation";
import { requireOnboardedUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { describeTimestamps, formatDay } from "@/lib/format-date";
import { providerLabel } from "@/lib/notes/list";
import { CollectionHeader } from "./collection-header";
import { TrackList } from "./track-list";
import { SharePanel } from "./share-panel";

export const dynamic = "force-dynamic";

/**
 * One collection snapshot, and the place notes get written in playlist context.
 *
 * The page was read-only until now, which made the schema's central idea
 * unreachable: `notes.collection_item_id` exists so that "this song, third into
 * this playlist" is a different thing to say than "this song". A collection you
 * can look at but not annotate is a track listing.
 */
export default async function CollectionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireOnboardedUser(`/collections/${id}`);

  // Owner-scoped in the query: a valid id belonging to someone else is a 404,
  // indistinguishable from one that never existed.
  const collection = await prisma.collection.findFirst({
    where: { id, ownerId: user.id },
    include: {
      // The note about the collection as a whole. Scoped to this user even
      // though the collection is already theirs — the relation is not itself
      // owner-scoped, and defence in depth here costs nothing.
      notes: {
        where: { ownerId: user.id },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { id: true, body: true, sharedInCollection: true },
      },
      items: {
        orderBy: { position: "asc" },
        include: {
          recording: {
            include: {
              artists: { orderBy: { position: "asc" }, include: { artist: true } },
              externalIds: { take: 1 },
              album: { select: { title: true, artworkThumbUrl: true, artworkUrl: true } },
            },
          },
          notes: {
            where: { ownerId: user.id },
            orderBy: { createdAt: "asc" },
            select: { id: true, body: true, sharedInCollection: true },
          },
        },
      },
    },
  });

  if (!collection) notFound();

  const annotated = collection.items.filter((i) => i.notes.length > 0).length;
  const baseUrl = process.env.APP_BASE_URL ?? "http://localhost:3100";
  const rootNote = collection.notes[0] ?? null;

  const timestamps = collection.sourceSnapshotAt
    ? `imported ${formatDay(collection.sourceSnapshotAt)}`
    : describeTimestamps(collection.createdAt, collection.updatedAt).toLowerCase();

  return (
    <main>
      <CollectionHeader
        collectionId={collection.id}
        name={collection.name}
        description={collection.description}
        kindLabel={collection.sourceUrl ? "Collection snapshot" : "Collection"}
        artworkUrl={collection.artworkUrl}
        trackCount={collection.items.length}
        annotatedCount={annotated}
        timestamps={timestamps}
        sourceUrl={collection.sourceUrl}
        sourceName={providerLabel(collection.sourceProvider)}
        canRefresh={Boolean(collection.sourceProvider && collection.sourceId)}
        refreshedAt={collection.refreshedAt}
        rootNote={rootNote ? { id: rootNote.id, body: rootNote.body } : null}
      />

      <SharePanel
        collectionId={collection.id}
        visibility={collection.visibility}
        shareToken={collection.shareToken}
        baseUrl={baseUrl}
        trackCount={collection.items.length}
        notes={[
          ...(rootNote
            ? [
                {
                  id: rootNote.id,
                  body: rootNote.body,
                  shared: rootNote.sharedInCollection,
                  trackTitle: null,
                },
              ]
            : []),
          ...collection.items.flatMap((item) =>
            item.notes.map((n) => ({
              id: n.id,
              body: n.body,
              shared: n.sharedInCollection,
              trackTitle: item.recording.title,
            })),
          ),
        ]}
      />

      <TrackList
        collectionId={collection.id}
        tracks={collection.items.map((item) => {
          const recording = item.recording;
          const external = recording.externalIds[0];
          return {
            id: item.id,
            position: item.position + 1,
            title: recording.title,
            artists:
              recording.artists.length > 0
                ? recording.artists.map((ra) => ra.artist.name).join(", ")
                : recording.artistDisplay,
            albumTitle: recording.album?.title ?? recording.releaseTitle,
            artworkThumbUrl:
              recording.artworkThumbUrl ??
              recording.album?.artworkThumbUrl ??
              recording.artworkUrl ??
              recording.album?.artworkUrl ??
              null,
            artworkUrl: recording.artworkUrl ?? recording.album?.artworkUrl ?? null,
            providerUrl: trackUrl(external),
            providerName: providerLabel(external?.provider ?? null),
            note: item.notes[0] ? { id: item.notes[0].id, body: item.notes[0].body } : null,
          };
        })}
      />

      <p className="note" style={{ marginTop: "2rem" }}>
        <Link href="/collections">All collections</Link> · <Link href="/notes">Notes</Link>
      </p>
    </main>
  );
}
