import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { users } from "../models/schema.js";
import { webhooksRoutes } from "./webhooks.routes.js";
import { eq } from "drizzle-orm";

const { db, client } = testDb();
// The bytes svix's Webhook.verify() actually HMACs with are whatever is
// base64-decoded out of the "whsec_" secret - encoding SECRET_RAW's own
// bytes here means signedRequest() below reproduces exactly what
// verify() expects, without depending on svix's own signing helper.
const SECRET_RAW = "test-secret-for-webhook-signing-1234567890";
const SECRET = `whsec_${Buffer.from(SECRET_RAW).toString("base64")}`;

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

function signedRequest(body: unknown): Request {
  const payload = JSON.stringify(body);
  const id = "msg_test_1";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signedContent = `${id}.${timestamp}.${payload}`;
  const signature = createHmac("sha256", Buffer.from(SECRET_RAW)).update(signedContent).digest("base64");

  return new Request("http://test/webhooks/clerk", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${signature}`,
    },
    body: payload,
  });
}

describe("POST /webhooks/clerk", () => {
  it("401s on a bad signature", async () => {
    const req = new Request("http://test/webhooks/clerk", {
      method: "POST",
      headers: { "content-type": "application/json", "svix-id": "x", "svix-timestamp": "1", "svix-signature": "bad" },
      body: "{}",
    });
    const res = await webhooksRoutes.fetch(req, testEnv({ CLERK_WEBHOOK_SECRET: SECRET }), testExecutionCtx());
    expect(res.status).toBe(401);
  });

  it("upserts a users row on user.created", async () => {
    const req = signedRequest({
      type: "user.created",
      data: {
        id: "user_new",
        email_addresses: [{ email_address: "new@example.com" }],
        first_name: "New",
        last_name: "User",
        image_url: "https://img.example.com/a.png",
      },
    });
    const res = await webhooksRoutes.fetch(req, testEnv({ CLERK_WEBHOOK_SECRET: SECRET }), testExecutionCtx());
    expect(res.status).toBe(200);

    const [row] = await db.select().from(users).where(eq(users.clerkUserId, "user_new"));
    expect(row.email).toBe("new@example.com");
    expect(row.name).toBe("New User");
  });

  it("is idempotent on a repeated user.updated event", async () => {
    const makeReq = () =>
      signedRequest({
        type: "user.updated",
        data: {
          id: "user_dup",
          email_addresses: [{ email_address: "dup@example.com" }],
          first_name: "Dup",
          last_name: null,
          image_url: null,
        },
      });

    await webhooksRoutes.fetch(makeReq(), testEnv({ CLERK_WEBHOOK_SECRET: SECRET }), testExecutionCtx());
    const res2 = await webhooksRoutes.fetch(makeReq(), testEnv({ CLERK_WEBHOOK_SECRET: SECRET }), testExecutionCtx());
    expect(res2.status).toBe(200);

    const rows = await db.select().from(users).where(eq(users.clerkUserId, "user_dup"));
    expect(rows).toHaveLength(1);
  });
});
