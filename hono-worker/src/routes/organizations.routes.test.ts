import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { memberships } from "../models/schema.js";
import { organizationsRoutes } from "./organizations.routes.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

function authed(userId: string) {
  return { Authorization: `Bearer ${userId}` };
}

describe("POST /organizations", () => {
  it("creates an org and makes the creator its admin", async () => {
    const res = await organizationsRoutes.fetch(
      new Request("http://test/organizations", {
        method: "POST",
        headers: { ...authed("user_1"), "content-type": "application/json" },
        body: JSON.stringify({ name: "ACME Corp" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { organization: { id: string; name: string } };
    expect(body.organization.name).toBe("ACME Corp");

    const rows = await db.select().from(memberships).where(eq(memberships.organizationId, body.organization.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clerkUserId: "user_1", role: "admin", status: "active" });
  });

  it("401s without a bearer token", async () => {
    const res = await organizationsRoutes.fetch(
      new Request("http://test/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "ACME Corp" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(401);
  });

  it("400s on an empty name", async () => {
    const res = await organizationsRoutes.fetch(
      new Request("http://test/organizations", {
        method: "POST",
        headers: { ...authed("user_1"), "content-type": "application/json" },
        body: JSON.stringify({ name: "" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /organizations", () => {
  it("lists only the organizations the caller belongs to", async () => {
    await organizationsRoutes.fetch(
      new Request("http://test/organizations", {
        method: "POST",
        headers: { ...authed("user_1"), "content-type": "application/json" },
        body: JSON.stringify({ name: "Org One" }),
      }),
      testEnv(), testExecutionCtx(),
    );
    await organizationsRoutes.fetch(
      new Request("http://test/organizations", {
        method: "POST",
        headers: { ...authed("user_2"), "content-type": "application/json" },
        body: JSON.stringify({ name: "Org Two" }),
      }),
      testEnv(), testExecutionCtx(),
    );

    const res = await organizationsRoutes.fetch(
      new Request("http://test/organizations", { headers: authed("user_1") }),
      testEnv(), testExecutionCtx(),
    );
    const body = (await res.json()) as { organizations: { organization: { name: string } }[] };
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0]?.organization.name).toBe("Org One");
  });
});
