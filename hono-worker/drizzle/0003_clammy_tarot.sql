CREATE TABLE "ai_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"proposal_type" varchar(40) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"job_id" uuid,
	"diff" jsonb NOT NULL,
	"model_used" varchar(100),
	"reviewed_by" varchar(255),
	"reviewed_at" timestamp with time zone,
	"sign_off_hash" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"account_type" varchar(30) NOT NULL,
	"account_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"delta_minor" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"sequence" bigserial NOT NULL,
	"event_type" varchar(50) NOT NULL,
	"entity_type" varchar(30) NOT NULL,
	"entity_id" uuid NOT NULL,
	"amount_minor" bigint,
	"currency" varchar(3),
	"payload" jsonb NOT NULL,
	"reverses_event_id" uuid,
	"actor_clerk_user_id" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pii_tokens" (
	"token" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"field_type" varchar(20) NOT NULL,
	"ciphertext" text NOT NULL,
	"entity_type" varchar(30) NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_proposals" ADD CONSTRAINT "ai_proposals_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_balances" ADD CONSTRAINT "ledger_balances_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_balances" ADD CONSTRAINT "ledger_balances_event_id_ledger_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."ledger_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_events" ADD CONSTRAINT "ledger_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pii_tokens" ADD CONSTRAINT "pii_tokens_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_proposals_org_status" ON "ai_proposals" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "idx_balance_org_account" ON "ledger_balances" USING btree ("organization_id","account_type","account_id");--> statement-breakpoint
CREATE INDEX "idx_ledger_org_seq" ON "ledger_events" USING btree ("organization_id","sequence");--> statement-breakpoint
CREATE INDEX "idx_ledger_org_entity" ON "ledger_events" USING btree ("organization_id","entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ledger_reversal" ON "ledger_events" USING btree ("reverses_event_id");--> statement-breakpoint
CREATE INDEX "idx_pii_entity" ON "pii_tokens" USING btree ("organization_id","entity_type","entity_id");