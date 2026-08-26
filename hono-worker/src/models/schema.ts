import { pgTable, uuid, integer, varchar, text, timestamp, unique, index } from "drizzle-orm/pg-core";

// Mirrors CLAUDE.md's Scenario A chunking-pipeline schema. Every FK and
// WHERE-filtered column gets an explicit index (database-indexing.md rule 1).
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  clerkUserId: varchar("clerk_user_id", { length: 255 }).notNull(),
  status: varchar("status", { length: 50 }).default("active").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull().references(() => sessions.id),
    chunkIndex: integer("chunk_index").notNull(),
    bucketPath: text("bucket_path").notNull(),
    checksum: text("checksum").notNull(),
    status: varchar("status", { length: 50 }).default("pending").notNull(),
  },
  (t) => [
    index("idx_chunks_session").on(t.sessionId),
    // Compound unique + lookup index - idempotent upserts key off this pair
    // (idempotency-checksums.md rule 3).
    unique("uq_chunks_session_index").on(t.sessionId, t.chunkIndex),
  ],
);
