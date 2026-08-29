import type { Context } from "hono";
import type { z } from "zod/v4";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { AppBindings } from "../lib/context.js";
import { getDb } from "../models/db.js";
import { timeEntries, employees } from "../models/schema.js";
import { computeAttendance, type Punch } from "../lib/hris.js";
import type { HrisWebhookBody } from "../schemas/payroll.schema.js";

type WebhookIn = {
  in: { json: z.input<typeof HrisWebhookBody> };
  out: { json: z.infer<typeof HrisWebhookBody> };
};

/**
 * Public ingestion endpoint (api-security.md rule 2 - explicitly a webhook,
 * not gated by Clerk auth) for any external HRIS/time system to POST clock
 * punches. Gated by a shared secret header instead, mirroring the Clerk
 * webhook's degrade-cleanly contract: unconfigured -> 501, mismatched ->
 * 401, never a crash.
 *
 * `:orgId` is a path param, not resolved from a Clerk session - there is no
 * user session here, just a system-to-system call - so it's trusted only
 * because the shared secret already proved the caller is authorized to
 * write into this org's attendance data at all.
 */
export async function ingestHrisWebhook(c: Context<AppBindings, string, WebhookIn>): Promise<Response> {
  if (!c.env.HRIS_WEBHOOK_SECRET) {
    return c.json({ error: { message: "HRIS webhook not configured", statusCode: 501 } }, 501);
  }
  const provided = c.req.header("x-hris-secret");
  // Never log the secret or the header value either way - api-security.md rule 3.
  if (!provided || provided !== c.env.HRIS_WEBHOOK_SECRET) {
    return c.json({ error: { message: "Invalid webhook secret", statusCode: 401 } }, 401);
  }

  const orgId = c.req.param("orgId");
  if (!orgId) return c.json({ error: { message: "orgId is required", statusCode: 400 } }, 400);

  const conn = getDb(c.env);
  if (!conn) return c.json({ error: { message: "Database not configured", statusCode: 503 } }, 503);

  try {
    const { source, punches } = c.req.valid("json");

    // Idempotent upsert against the unique (organizationId, source,
    // externalId) index - a retried delivery of the same punch is a no-op,
    // never a duplicate row (idempotency-checksums.md rule 3).
    const inserted = await conn.db
      .insert(timeEntries)
      .values(
        punches.map((p) => ({
          organizationId: orgId,
          employeeId: p.employeeId,
          type: p.type,
          occurredAt: new Date(p.occurredAt),
          source,
          externalId: p.externalId,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: timeEntries.id });

    return c.json({ status: "ok", received: punches.length, inserted: inserted.length });
  } finally {
    c.executionCtx.waitUntil(conn.close());
  }
}

/**
 * Read-only: raw punches for one employee/period plus the deterministic
 * hours computed from them (lib/hris.ts, pure, no AI) - the same function
 * EWA accrual uses, so what the UI shows and what EWA enforces can never
 * drift apart.
 */
export async function getAttendance(c: Context<AppBindings>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const employeeId = c.req.param("employeeId");
  const periodStart = c.req.query("periodStart");
  const periodEnd = c.req.query("periodEnd");
  if (!employeeId || !periodStart || !periodEnd) {
    return c.json(
      { error: { message: "employeeId, periodStart and periodEnd are required", statusCode: 400 } },
      400,
    );
  }

  const [employee] = await db
    .select()
    .from(employees)
    .where(and(eq(employees.id, employeeId), eq(employees.organizationId, orgId)))
    .limit(1);
  if (!employee) return c.json({ error: { message: "Employee not found", statusCode: 404 } }, 404);

  const rows = await db
    .select()
    .from(timeEntries)
    .where(
      and(
        eq(timeEntries.organizationId, orgId),
        eq(timeEntries.employeeId, employeeId),
        gte(timeEntries.occurredAt, new Date(`${periodStart}T00:00:00.000Z`)),
        lte(timeEntries.occurredAt, new Date(`${periodEnd}T23:59:59.999Z`)),
      ),
    )
    .orderBy(asc(timeEntries.occurredAt));

  const punches: Punch[] = rows.map((r) => ({
    type: r.type as "clock_in" | "clock_out",
    occurredAt: r.occurredAt.toISOString(),
  }));
  const attendance = computeAttendance(punches);

  return c.json({ entries: rows, attendance });
}
