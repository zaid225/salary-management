import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships } from "../models/schema.js";
import { resolveOrg, requireRole } from "./auth.middleware.js";
import type { AppBindings } from "../lib/context.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

// Isolates resolveOrg/requireRole from requireAuth's Clerk call - a
// preceding test-only middleware sets userId directly from a header.
function buildTestApp() {
  const app = new Hono<AppBindings>();
  app.use("*", async (c, next) => {
    c.set("userId", c.req.header("x-test-user") ?? "");
    await next();
  });
  app.get("/test", resolveOrg, requireRole("admin"), (c) =>
    c.json({ ok: true, orgId: c.get("orgId"), orgRole: c.get("orgRole") }),
  );
  return app;
}

async function seedOrgWithMembers() {
  const [org] = await db.insert(organizations).values({ name: "ACME", slug: "acme" }).returning();
  await db.insert(memberships).values([
    { organizationId: org.id, clerkUserId: "user_admin", role: "admin", status: "active" },
    { organizationId: org.id, clerkUserId: "user_viewer", role: "viewer", status: "active" },
    { organizationId: org.id, clerkUserId: "user_removed", role: "admin", status: "removed" },
  ]);
  return org;
}

describe("resolveOrg + requireRole", () => {
  it("400s when X-Org-Id is missing", async () => {
    const app = buildTestApp();
    const res = await app.fetch(
      new Request("http://test/test", { headers: { "x-test-user": "user_admin" } }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(400);
  });

  it("403s for a user with no active membership in that org", async () => {
    const org = await seedOrgWithMembers();
    const app = buildTestApp();
    const res = await app.fetch(
      new Request("http://test/test", {
        headers: { "x-test-user": "user_stranger", "X-Org-Id": org.id },
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(403);
  });

  it("403s for a removed membership", async () => {
    const org = await seedOrgWithMembers();
    const app = buildTestApp();
    const res = await app.fetch(
      new Request("http://test/test", {
        headers: { "x-test-user": "user_removed", "X-Org-Id": org.id },
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(403);
  });

  it("403s an active viewer against requireRole(admin)", async () => {
    const org = await seedOrgWithMembers();
    const app = buildTestApp();
    const res = await app.fetch(
      new Request("http://test/test", {
        headers: { "x-test-user": "user_viewer", "X-Org-Id": org.id },
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(403);
  });

  it("200s an active admin and sets orgId/orgRole", async () => {
    const org = await seedOrgWithMembers();
    const app = buildTestApp();
    const res = await app.fetch(
      new Request("http://test/test", {
        headers: { "x-test-user": "user_admin", "X-Org-Id": org.id },
      }),
      testEnv(), testExecutionCtx(),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, orgId: org.id, orgRole: "admin" });
  });
});
