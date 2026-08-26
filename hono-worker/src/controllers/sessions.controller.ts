import type { Context } from "hono";
import { z } from "zod/v4";
import { desc, eq } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { getDb } from "../models/db.js";
import { sessions } from "../models/schema.js";

export const CreateSessionBody = z.object({
  clerkUserId: z.string().min(1),
});

export const ListSessionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().min(0).default(0),
});

export async function listSessions(
  c: Context<
    AppBindings,
    string,
    { in: { query: z.input<typeof ListSessionsQuery> }; out: { query: z.infer<typeof ListSessionsQuery> } }
  >,
): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) {
    return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);
  }

  const { limit, cursor } = c.req.valid("query");
  try {
    // Paginated, never unbounded - database-indexing.md rule 2.
    const rows = await conn.db
      .select()
      .from(sessions)
      .orderBy(desc(sessions.createdAt))
      .limit(limit)
      .offset(cursor);

    return c.json({ sessions: rows, nextCursor: rows.length === limit ? cursor + limit : null });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}

export async function createSession(
  c: Context<
    AppBindings,
    string,
    { in: { json: z.infer<typeof CreateSessionBody> }; out: { json: z.infer<typeof CreateSessionBody> } }
  >,
): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) {
    return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);
  }

  const { clerkUserId } = c.req.valid("json");
  try {
    const [session] = await conn.db.insert(sessions).values({ clerkUserId }).returning();
    return c.json({ session }, 201);
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}

export async function getSession(c: Context<AppBindings>): Promise<Response> {
  const conn = getDb(c.env);
  if (!conn) {
    return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);
  }

  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: { message: "Session id required", statusCode: 400 } }, 400);
  }
  try {
    const [session] = await conn.db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
    if (!session) {
      return c.json({ error: { message: "Session not found", statusCode: 404 } }, 404);
    }
    return c.json({ session });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}
