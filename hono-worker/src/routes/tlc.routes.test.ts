import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships, fxRates } from "../models/schema.js";
import { tlcRoutes } from "./tlc.routes.js";

const { db, client } = testDb();

beforeEach(async () => {
  await truncateAll(db);
});

afterAll(async () => {
  await client.end();
});

function authed(userId: string, orgId: string) {
  return { Authorization: `Bearer ${userId}`, "X-Org-Id": orgId };
}

function get(orgId: string, qs: string) {
  return tlcRoutes.fetch(
    new Request(`http://test/tlc/compare${qs}`, { headers: authed("admin_1", orgId) }),
    testEnv(),
    testExecutionCtx(),
  );
}

async function seedOrg() {
  const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-tlc" }).returning();
  const org = orgRows[0]!;
  await db
    .insert(memberships)
    .values({ organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" });
  return org;
}

interface TlcResult {
  jurisdiction: string;
  currency: string;
  missingFxRate: boolean;
  totalLandedCostLocalMinor?: number;
  totalLandedCostUsdMinor?: number;
}

describe("GET /tlc/compare", () => {
  it("400s when budgetUsdMinor is missing", async () => {
    const org = await seedOrg();
    const res = await get(org.id, "");
    expect(res.status).toBe(400);
  });

  it("400s an unsupported jurisdiction", async () => {
    const org = await seedOrg();
    const res = await get(org.id, "?budgetUsdMinor=10000000&jurisdictions=FR");
    expect(res.status).toBe(400);
  });

  it("compares all three supported jurisdictions with fx rates configured, USD always at 1:1", async () => {
    const org = await seedOrg();
    await db.insert(fxRates).values([
      { currency: "USD", rateToUsd: "1.000000", asOfDate: "2026-01-01" },
      { currency: "GBP", rateToUsd: "1.270000", asOfDate: "2026-01-01" },
      { currency: "INR", rateToUsd: "0.012000", asOfDate: "2026-01-01" },
    ]);

    const res = await get(org.id, "?budgetUsdMinor=10000000"); // $100,000
    expect(res.status).toBe(200);
    const body = (await res.json()) as { budgetUsdMinor: number; results: TlcResult[] };
    expect(body.results).toHaveLength(3);

    const usCa = body.results.find((r) => r.jurisdiction === "US-CA")!;
    expect(usCa.missingFxRate).toBe(false);
    // USD budget converted to USD is exact - $100,000 gross -> $110,650 TLC
    // (see total-landed-cost.test.ts's own hand-verified US-CA case).
    expect(usCa.totalLandedCostLocalMinor).toBe(110_650_00);
    expect(usCa.totalLandedCostUsdMinor).toBe(110_650_00);

    // Every jurisdiction's true cost must exceed the raw budget - employer
    // contributions are strictly additive, never a discount.
    for (const r of body.results) {
      expect(r.totalLandedCostUsdMinor).toBeGreaterThan(10_000_000);
    }
  });

  it("excludes a jurisdiction whose currency has no fx_rates row, rather than fabricating a rate", async () => {
    const org = await seedOrg();
    // Only USD configured - GBP and INR are missing.
    await db.insert(fxRates).values([{ currency: "USD", rateToUsd: "1.000000", asOfDate: "2026-01-01" }]);

    const res = await get(org.id, "?budgetUsdMinor=10000000");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: TlcResult[] };
    const uk = body.results.find((r) => r.jurisdiction === "UK")!;
    const india = body.results.find((r) => r.jurisdiction === "IN")!;
    expect(uk.missingFxRate).toBe(true);
    expect(india.missingFxRate).toBe(true);
    expect(uk.totalLandedCostLocalMinor).toBeUndefined();
  });

  it("restricts the comparison to the requested jurisdictions only", async () => {
    const org = await seedOrg();
    await db.insert(fxRates).values([{ currency: "USD", rateToUsd: "1.000000", asOfDate: "2026-01-01" }]);
    const res = await get(org.id, "?budgetUsdMinor=10000000&jurisdictions=US-CA");
    const body = (await res.json()) as { results: TlcResult[] };
    expect(body.results).toHaveLength(1);
    expect(body.results[0]!.jurisdiction).toBe("US-CA");
  });
});
