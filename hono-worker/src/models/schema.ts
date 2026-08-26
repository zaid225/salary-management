import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  unique,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// --- Local mirror of Clerk identity, kept in sync via webhook (design spec §3) ---
// Clerk stays the source of truth for auth; this table exists so member
// lists/audit-log entries can show a name/email/avatar without an
// out-of-band Clerk API call on every request.

export const users = pgTable("users", {
  clerkUserId: varchar("clerk_user_id", { length: 255 }).primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  name: varchar("name", { length: 200 }),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- Organizations, membership, invitations (custom, not Clerk Orgs — design spec §5) ---

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 200 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("uq_organizations_slug").on(t.slug)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    clerkUserId: varchar("clerk_user_id", { length: 255 }).notNull(),
    role: varchar("role", { length: 20 }).notNull(), // admin | viewer
    status: varchar("status", { length: 20 }).notNull().default("active"), // active | removed
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_memberships_org_user").on(t.organizationId, t.clerkUserId),
    index("idx_memberships_user").on(t.clerkUserId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id),
    email: varchar("email", { length: 255 }).notNull(),
    role: varchar("role", { length: 20 }).notNull(), // admin | viewer
    token: varchar("token", { length: 64 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | accepted | revoked
    invitedBy: varchar("invited_by", { length: 255 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("uq_invitations_token").on(t.token),
    // Idempotency: one live invite per (org, email) at a time
    // (idempotency-checksums.md rule 3's upsert-over-insert principle).
    uniqueIndex("uq_invitations_org_email_pending")
      .on(t.organizationId, t.email)
      .where(sql`${t.status} = 'pending'`),
  ],
);
