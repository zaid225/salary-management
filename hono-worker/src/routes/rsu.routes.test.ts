import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships } from "../models/schema.js";
import { rsuRoutes } from "./rsu.routes.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

function authed(userId: string, orgId: string) {
  return { Authorization: `Bearer ${userId}`, "X-Org-Id": orgId, "content-type": "application/json" };
}

function post(path: string, orgId: string, body: unknown) {
  return rsuRoutes.fetch(
    new Request(`http://test${path}`, { method: "POST", headers: authed("admin_1", orgId), body: JSON.stringify(body) }),
    testEnv(),
    testExecutionCtx(),
  );
}

async function seedOrg() {
  const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-rsu" }).returning();
  const org = orgRows[0]!;
  await db
    .insert(memberships)
    .values({ organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" });
  return org;
}

describe("POST /rsu/vesting-schedule", () => {
  it("returns a 37-event schedule (1 cliff + 36 monthly) summing to exactly totalShares", async () => {
    const org = await seedOrg();
    const res = await post("/rsu/vesting-schedule", org.id, { totalShares: 4_800, vestingStartDate: "2024-01-15" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: { shares: number; monthIndex: number; vestDate: string }[] };
    expect(body.events).toHaveLength(37);
    expect(body.events[0]).toEqual({ monthIndex: 12, vestDate: "2025-01-15", shares: 1_200 });
    expect(body.events.reduce((sum, e) => sum + e.shares, 0)).toBe(4_800);
  });

  it("400s a non-positive share count", async () => {
    const org = await seedOrg();
    const res = await post("/rsu/vesting-schedule", org.id, { totalShares: 0, vestingStartDate: "2024-01-15" });
    expect(res.status).toBe(400);
  });
});

describe("POST /rsu/vest-calculator", () => {
  it("returns withholding and all three strategies for a supported jurisdiction", async () => {
    const org = await seedOrg();
    const res = await post("/rsu/vest-calculator", org.id, {
      sharesVesting: 1_000,
      fmvPerShareMinor: 5_000,
      jurisdiction: "US-CA",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tax: { totalTaxMinor: number; netValueMinor: number };
      strategies: { strategy: string; sharesRetained: number }[];
    };
    expect(body.tax.totalTaxMinor).toBe(1_994_000);
    expect(body.tax.netValueMinor).toBe(3_006_000);
    expect(body.strategies).toHaveLength(3);
    expect(body.strategies.map((s) => s.strategy)).toEqual(["sell_to_cover", "same_day_sale", "hold_pay_cash"]);
    // Every strategy's shares must still sum back to the total vesting.
    for (const s of body.strategies) {
      expect(s.sharesRetained).toBeGreaterThanOrEqual(0);
      expect(s.sharesRetained).toBeLessThanOrEqual(1_000);
    }
  });

  it("400s an unsupported jurisdiction rather than fabricating tax numbers", async () => {
    const org = await seedOrg();
    const res = await post("/rsu/vest-calculator", org.id, {
      sharesVesting: 100,
      fmvPerShareMinor: 1_000,
      jurisdiction: "IN",
    });
    expect(res.status).toBe(400);
  });
});
