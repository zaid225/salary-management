import type { Context } from "hono";
import type { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { z as zod } from "zod/v4";
import type { AppBindings } from "../lib/context.js";
import { jobs, aiProposals, piiTokens, ledgerEvents } from "../models/schema.js";
import { desc } from "drizzle-orm";
import { scopedDb } from "../models/scoped-db.js";
import { encryptPii } from "../lib/pii.js";
import { toToon } from "../lib/toon.js";
import { complete } from "../lib/openrouter.js";
import { appendJobLog } from "../models/jobs.js";
import type { StartPreflightAuditBody, ReviewProposalBody } from "../schemas/payroll.schema.js";

// The shape the model is asked to return - validated before it can
// influence anything (Rule #1: LLMs never do math, they only flag; Rule #4:
// deterministic subsystems reject a malformed tool call rather than
// partially applying it).
const AnomalyFindings = zod.object({
  flags: zod.array(
    zod.object({
      employeeToken: zod.string(),
      reason: zod.string(),
      severity: zod.enum(["low", "medium", "high"]),
    }),
  ),
});

type StartAuditIn = {
  in: { json: z.input<typeof StartPreflightAuditBody> };
  out: { json: z.infer<typeof StartPreflightAuditBody> };
};

/**
 * "Shadow payroll" pre-flight auditor. The gross-to-net numbers themselves
 * come from this org's existing salary_records (deterministic, no LLM,
 * same source analytics.controller.ts reads from) - the LLM is shown only
 * PII-tokenized rows and asked to flag anomalies against nothing but the
 * data it was given. Its output is stored as one ai_proposals row, status
 * 'pending'; nothing here ever writes to ledgerEvents or changes a payment.
 */
export async function startPreflightAudit(
  c: Context<AppBindings, string, StartAuditIn>,
): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const { periodStart, periodEnd } = c.req.valid("json");

  const scoped = scopedDb(db, orgId);
  const active = await scoped.employees.list({ limit: 1000, offset: 0 });
  if (active.length === 0) {
    return c.json(
      { error: { message: "No active employees to audit", statusCode: 400 } },
      400,
    );
  }

  const currentSalaries = await scoped.salaryRecords.currentFor(active.map((e) => e.id));

  // The job row is the audit run's own record - same shape as every other
  // long-running task in this app (jobs.ts), so it shows up in the same
  // job-progress UI and is safe to re-check on a retry.
  const [job] = await db
    .insert(jobs)
    .values({
      organizationId: orgId,
      type: "payroll_preflight_audit",
      status: "running",
      total: active.length,
      processed: active.length,
      params: { periodStart, periodEnd },
      runToken: crypto.randomUUID(),
      createdBy: userId,
    })
    .returning();
  if (!job) throw new Error("job insert did not return a row");

  // Tokenize before anything crosses the LLM boundary. The token is what
  // goes into the TOON payload; the real name is only ever readable via
  // pii_tokens, which the LLM path never queries.
  //
  // Encryption (in-memory SubtleCrypto, no I/O) still runs per-employee, but
  // the inserts are batched into a single round trip instead of N sequential
  // awaited INSERTs - with enough employees the old per-row loop added
  // real, avoidable latency on top of the model call's own up-to-55s
  // ceiling, which is what pushed some runs past the client's timeout.
  const auditable = active.filter((e) => currentSalaries.has(e.id));
  const ciphertexts = await Promise.all(
    auditable.map((e) => encryptPii(c.env, `${e.firstName} ${e.lastName}`)),
  );
  const tokenRows =
    auditable.length === 0
      ? []
      : await db
          .insert(piiTokens)
          .values(
            auditable.map((e, i) => ({
              organizationId: orgId,
              fieldType: "full_name",
              // Unconfigured PII_ENCRYPTION_KEY still tokenizes (the LLM never
              // sees the name either way) - it just can't be reversed later
              // until a key is set, which is the documented degrade path.
              ciphertext: ciphertexts[i] ?? "unconfigured:PII_ENCRYPTION_KEY",
              entityType: "employee",
              entityId: e.id,
            })),
          )
          .returning({ token: piiTokens.token, entityId: piiTokens.entityId });
  const tokenByEmployeeId = new Map(tokenRows.map((r) => [r.entityId, r.token]));

  const toonRows: { employeeToken: string; department: string; level: string; amountMinor: number }[] = [];
  for (const e of auditable) {
    const token = tokenByEmployeeId.get(e.id);
    if (!token) continue;
    const salary = currentSalaries.get(e.id)!;
    toonRows.push({
      employeeToken: token,
      department: e.department,
      level: e.level,
      // Integer minor units - never a float - matches ledgerEvents.amountMinor.
      amountMinor: Math.round(Number(salary.amount) * 100),
    });
  }

  const toonPayload = toToon(toonRows);
  const result = await complete(c.env, {
    model: "meta-llama/llama-3.1-8b-instruct",
    systemPrompt:
      "You audit payroll line items for anomalies (unusual amounts, outliers within a department/level) against ONLY the rows given. " +
      "You never compute or adjust pay - you only flag rows for human review. " +
      'Reply with strict JSON matching {"flags":[{"employeeToken":string,"reason":string,"severity":"low"|"medium"|"high"}]} and nothing else. ' +
      "If nothing looks anomalous, reply with an empty flags array.",
    userPrompt: toonPayload,
  });

  let diff: unknown;
  let modelUsed: string | null = "meta-llama/llama-3.1-8b-instruct";
  if (!result.ok) {
    diff = { error: result.error, flags: [] };
    modelUsed = null;
    await appendJobLog(db, job.id, "error", `Model call failed: ${result.error}`);
  } else {
    const parsed = AnomalyFindings.safeParse(safeJsonParse(result.text));
    if (parsed.success) {
      diff = parsed.data;
      await appendJobLog(db, job.id, "info", `${parsed.data.flags.length} anomaly flag(s) found.`);
    } else {
      // Rule #4: a malformed/hallucinated tool-call output is logged and
      // held for review, never silently coerced into something it isn't.
      diff = { unparsed: result.text, flags: [] };
      await appendJobLog(db, job.id, "warn", "Model output did not match the expected schema - stored unparsed.");
    }
  }

  const [proposal] = await db
    .insert(aiProposals)
    .values({
      organizationId: orgId,
      proposalType: "preflight_anomaly",
      status: "pending",
      jobId: job.id,
      diff,
      modelUsed,
    })
    .returning();

  await db.update(jobs).set({ status: "succeeded", finishedAt: new Date() }).where(eq(jobs.id, job.id));

  return c.json({ proposal, jobId: job.id }, 202);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

type ReviewIn = {
  in: { json: z.input<typeof ReviewProposalBody> };
  out: { json: z.infer<typeof ReviewProposalBody> };
};

/**
 * The human-in-the-loop gate. Approving a proposal does not, by itself,
 * touch ledgerEvents or salary_records - it only records who signed off and
 * when, with a hash binding that decision to the exact diff reviewed.
 * Applying an approved proposal is a deliberately separate action, not
 * implemented in this pass (see plan §3-4).
 */
export async function reviewProposal(c: Context<AppBindings, string, ReviewIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const userId = c.get("userId")!;
  const proposalId = c.req.param("proposalId");
  const { decision } = c.req.valid("json");

  if (!proposalId) {
    return c.json({ error: { message: "Proposal not found", statusCode: 404 } }, 404);
  }

  const [existing] = await db
    .select()
    .from(aiProposals)
    .where(eq(aiProposals.id, proposalId))
    .limit(1);
  if (!existing || existing.organizationId !== orgId) {
    return c.json({ error: { message: "Proposal not found", statusCode: 404 } }, 404);
  }
  if (existing.status !== "pending") {
    return c.json({ error: { message: "This proposal has already been reviewed", statusCode: 409 } }, 409);
  }

  const reviewedAt = new Date();
  const signOffHash = await sha256Hex(
    JSON.stringify(existing.diff) + userId + reviewedAt.toISOString() + decision,
  );

  const [updated] = await db
    .update(aiProposals)
    .set({ status: decision, reviewedBy: userId, reviewedAt, signOffHash })
    .where(eq(aiProposals.id, proposalId))
    .returning();

  return c.json({ proposal: updated });
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function listLedgerEvents(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  // Scaffold: newest-first, capped at 500 - a real ledger view needs the
  // same cursor pagination as the employee list, not built in this pass.
  const rows = await db
    .select()
    .from(ledgerEvents)
    .where(eq(ledgerEvents.organizationId, orgId))
    .orderBy(desc(ledgerEvents.sequence))
    .limit(500);
  return c.json({ events: rows });
}

export async function listProposals(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const rows = await db.select().from(aiProposals).where(eq(aiProposals.organizationId, orgId));
  return c.json({ proposals: rows });
}
