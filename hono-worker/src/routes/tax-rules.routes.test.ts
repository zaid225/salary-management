import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { testDb, testEnv, testExecutionCtx, truncateAll } from "../../test-utils/db.js";
import { organizations, memberships } from "../models/schema.js";
import { taxRulesRoutes } from "./tax-rules.routes.js";

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

function fetchIt(orgId: string, body: unknown) {
  return taxRulesRoutes.fetch(
    new Request("http://test/tax-rules/propose-diff", {
      method: "POST",
      headers: authed("admin_1", orgId),
      body: JSON.stringify(body),
    }),
    testEnv(),
    testExecutionCtx(),
  );
}

async function seedOrg() {
  const orgRows = await db.insert(organizations).values({ name: "ACME", slug: "acme-taxdiff" }).returning();
  const org = orgRows[0]!;
  await db
    .insert(memberships)
    .values({ organizationId: org.id, clerkUserId: "admin_1", role: "admin", status: "active" });
  return org;
}

interface ProposalResponse {
  proposal: {
    id: string;
    proposalType: string;
    status: string;
    modelUsed: string | null;
    diff: {
      jurisdiction: string;
      scenarios: { annualSalaryMinor: number; deltaMinor: number }[];
      totalDeltaMinor: number;
      error?: string;
    };
  };
  jobId: string;
}

describe("POST /tax-rules/propose-diff", () => {
  it("direct brackets: computes a deterministic diff with no model call, delta reflects the rate change", async () => {
    const org = await seedOrg();
    // Bump the $243,575-$609,350 bracket from 35% to 50% - $30k/$60k/$100k
    // golden salaries never reach it (untouched); $250k and $600k both fall
    // partly inside it (both real increases). The very top ($609,350+, at
    // 37%) is deliberately left unchanged and unreached by any golden
    // salary here - proving a diff only shows up where brackets actually
    // changed, not everywhere a bracket table happens to differ.
    const res = await fetchIt(org.id, {
      jurisdiction: "US-CA",
      proposedBrackets: [
        { upToAnnualMinor: 1_160_000, rate: 0.1 },
        { upToAnnualMinor: 4_715_000, rate: 0.12 },
        { upToAnnualMinor: 10_052_500, rate: 0.22 },
        { upToAnnualMinor: 19_195_000, rate: 0.24 },
        { upToAnnualMinor: 24_357_500, rate: 0.32 },
        { upToAnnualMinor: 60_935_000, rate: 0.5 }, // 0.35 -> 0.5
        { upToAnnualMinor: null, rate: 0.37 }, // unchanged
      ],
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as ProposalResponse;
    expect(body.proposal.proposalType).toBe("tax_diff");
    expect(body.proposal.status).toBe("pending");
    expect(body.proposal.modelUsed).toBeNull(); // direct path never calls the model
    expect(body.proposal.diff.jurisdiction).toBe("US-CA");
    // $30,000-$100,000 golden salaries never reach the changed bracket - untouched.
    const untouched = body.proposal.diff.scenarios.filter((s) => s.annualSalaryMinor <= 100_000_00);
    expect(untouched.every((s) => s.deltaMinor === 0)).toBe(true);
    // $250,000 and $600,000 both fall partly inside the raised bracket.
    const affected = body.proposal.diff.scenarios.filter((s) => s.annualSalaryMinor > 100_000_00);
    expect(affected.every((s) => s.deltaMinor > 0)).toBe(true);
    expect(body.proposal.diff.totalDeltaMinor).toBeGreaterThan(0);
  });

  it("identical brackets produce a zero-delta diff", async () => {
    const org = await seedOrg();
    const res = await fetchIt(org.id, {
      jurisdiction: "UK",
      proposedBrackets: [
        { upToAnnualMinor: 1_257_000, rate: 0 },
        { upToAnnualMinor: 5_027_000, rate: 0.2 },
        { upToAnnualMinor: 12_514_000, rate: 0.4 },
        { upToAnnualMinor: null, rate: 0.45 },
      ],
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as ProposalResponse;
    expect(body.proposal.diff.totalDeltaMinor).toBe(0);
    expect(body.proposal.diff.scenarios.every((s) => s.deltaMinor === 0)).toBe(true);
  });

  it("legalText path with OpenRouter unconfigured stores a rejected-looking pending proposal with the model error, never fabricates brackets", async () => {
    const org = await seedOrg();
    const res = await fetchIt(org.id, {
      jurisdiction: "IN",
      legalText: "The top marginal rate is hereby raised from 30% to 35%.",
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as ProposalResponse;
    expect(body.proposal.modelUsed).toBe("meta-llama/llama-3.1-8b-instruct");
    expect(body.proposal.diff.scenarios).toEqual([]);
    expect(body.proposal.diff.error).toBe("OpenRouter not configured");
  });

  it("400s when both legalText and proposedBrackets are given", async () => {
    const org = await seedOrg();
    const res = await fetchIt(org.id, {
      jurisdiction: "UK",
      legalText: "some text",
      proposedBrackets: [{ upToAnnualMinor: null, rate: 0.1 }],
    });
    expect(res.status).toBe(400);
  });

  it("400s when neither legalText nor proposedBrackets are given", async () => {
    const org = await seedOrg();
    const res = await fetchIt(org.id, { jurisdiction: "UK" });
    expect(res.status).toBe(400);
  });
});
