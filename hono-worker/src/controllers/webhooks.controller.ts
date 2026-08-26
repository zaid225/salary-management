import type { Context } from "hono";
import { Webhook } from "svix";
import type { AppBindings } from "../lib/context.js";
import { getDb } from "../models/db.js";
import { users } from "../models/schema.js";
import { logger } from "../lib/logger.js";

interface ClerkWebhookEvent {
  type: string;
  data: {
    id: string;
    email_addresses?: { email_address: string }[];
    first_name?: string | null;
    last_name?: string | null;
    image_url?: string | null;
  };
}

export async function handleClerkWebhook(c: Context<AppBindings>): Promise<Response> {
  if (!c.env.CLERK_WEBHOOK_SECRET) {
    return c.json({ error: { message: "Webhook not configured", statusCode: 501 } }, 501);
  }

  const payload = await c.req.text();
  const headers = {
    "svix-id": c.req.header("svix-id") ?? "",
    "svix-timestamp": c.req.header("svix-timestamp") ?? "",
    "svix-signature": c.req.header("svix-signature") ?? "",
  };

  let event: ClerkWebhookEvent;
  try {
    const wh = new Webhook(c.env.CLERK_WEBHOOK_SECRET);
    event = wh.verify(payload, headers) as ClerkWebhookEvent;
  } catch {
    // Never log the payload/secret - api-security.md rule 3.
    return c.json({ error: { message: "Invalid webhook signature", statusCode: 401 } }, 401);
  }

  if (event.type !== "user.created" && event.type !== "user.updated") {
    return c.json({ status: "ignored" });
  }

  const conn = getDb(c.env);
  if (!conn) {
    return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);
  }

  try {
    const email = event.data.email_addresses?.[0]?.email_address ?? "";
    const name = [event.data.first_name, event.data.last_name].filter(Boolean).join(" ") || null;

    await conn.db
      .insert(users)
      .values({
        clerkUserId: event.data.id,
        email,
        name,
        avatarUrl: event.data.image_url ?? null,
      })
      .onConflictDoUpdate({
        target: users.clerkUserId,
        set: { email, name, avatarUrl: event.data.image_url ?? null, updatedAt: new Date() },
      });

    logger.info({ clerkUserId: event.data.id, type: event.type }, "synced user from Clerk webhook");
    return c.json({ status: "ok" });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}
