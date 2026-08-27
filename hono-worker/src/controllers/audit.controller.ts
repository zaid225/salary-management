import type { Context } from "hono";
import type { z } from "zod/v4";
import { scopedDb } from "../models/scoped-db.js";
import type { AppBindings } from "../lib/context.js";
import type { AuditLogQuery } from "../schemas/audit.schema.js";

type AuditIn = {
  in: { query: z.input<typeof AuditLogQuery> };
  out: { query: z.infer<typeof AuditLogQuery> };
};

export async function listAuditLog(c: Context<AppBindings, string, AuditIn>): Promise<Response> {
  const db = c.get("db")!;
  const orgId = c.get("orgId")!;
  const { limit, offset, entityType, entityId } = c.req.valid("query");

  const entries = await scopedDb(db, orgId).auditLog.list({ limit, offset, entityType, entityId });
  return c.json({ entries, limit, offset });
}
