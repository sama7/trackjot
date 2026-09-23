import { PrismaClient } from "@prisma/client";

/**
 * Direct looks at the database and at Clerk, for specs that must prove
 * something was *deleted* — which the UI alone cannot show, since a page that
 * no longer lists a row says nothing about whether the row still exists.
 *
 * Both refuse anything but disposable targets: a local database, and a Clerk
 * development instance. Nothing here may ever be pointed at production.
 */

let client: PrismaClient | null = null;

export function testDb(): PrismaClient {
  const url = process.env.DATABASE_URL ?? "";
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (!["localhost", "127.0.0.1"].includes(host)) {
    throw new Error("testDb: DATABASE_URL must point at a local disposable database.");
  }
  client ??= new PrismaClient();
  return client;
}

/** 200 while the Clerk user exists, 404 once it has been deleted. */
export async function clerkUserStatus(userId: string): Promise<number> {
  const key = process.env.CLERK_SECRET_KEY ?? "";
  if (!key.startsWith("sk_test_")) {
    throw new Error("clerkUserStatus: needs a Clerk DEVELOPMENT secret key (sk_test_…).");
  }
  const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  return response.status;
}
