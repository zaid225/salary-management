CREATE TABLE "ewa_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"requested_minor" bigint NOT NULL,
	"accrued_at_request_minor" bigint NOT NULL,
	"max_allowed_at_request_minor" bigint NOT NULL,
	"currency" varchar(3) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"requested_by" varchar(255) NOT NULL,
	"reviewed_by" varchar(255),
	"reviewed_at" timestamp with time zone,
	"ledger_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ewa_requests" ADD CONSTRAINT "ewa_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ewa_requests" ADD CONSTRAINT "ewa_requests_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ewa_requests" ADD CONSTRAINT "ewa_requests_ledger_event_id_ledger_events_id_fk" FOREIGN KEY ("ledger_event_id") REFERENCES "public"."ledger_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ewa_org_status" ON "ewa_requests" USING btree ("organization_id","status");