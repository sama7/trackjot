-- Sign-in subjects whose account was just deleted.
--
-- Deleting the Clerk user revokes its sessions, but a session token already in
-- a browser stays valid until it expires (about a minute). Users are created
-- lazily on first sight, so any request in that window re-created an empty
-- account under the deleted identity. A tombstone refuses that creation.
--
-- Holds an opaque provider id and a timestamp — nothing personal — and rows
-- older than a day are pruned on the next deletion, long after any token
-- issued before the deletion has expired.
CREATE TABLE "identity_tombstones" (
    "auth_subject" TEXT NOT NULL,
    "deleted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_tombstones_pkey" PRIMARY KEY ("auth_subject")
);
