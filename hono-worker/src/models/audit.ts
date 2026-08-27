import { auditLog } from "./schema.js";
import type { Db } from "./db.js";

// Drizzle's transaction callback param type isn't exported under a clean
// name in this version - accept the same shape a `tx` inside
// `db.transaction(async (tx) => {...})` satisfies.
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;

export interface WriteAuditParams {
  organizationId: string;
  actorClerkUserId: string;
  action: "create" | "update" | "delete";
  entityType: "employee" | "salary_record";
  entityId: string;
  before: unknown;
  after: unknown;
}

// Called from inside the same db.transaction(...) as the row write it
// documents, so the audit entry and the mutation commit together or not
// at all (design spec §3, database-indexing.md rule 4).
export async function writeAudit(tx: Tx, params: WriteAuditParams): Promise<void> {
  await tx.insert(auditLog).values({
    organizationId: params.organizationId,
    actorClerkUserId: params.actorClerkUserId,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    before: params.before,
    after: params.after,
  });
}
