CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_clerk_user_id" varchar(255) NOT NULL,
	"action" varchar(20) NOT NULL,
	"entity_type" varchar(30) NOT NULL,
	"entity_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_number" varchar(32) NOT NULL,
	"first_name" varchar(100) NOT NULL,
	"last_name" varchar(100) NOT NULL,
	"email" varchar(255) NOT NULL,
	"country" varchar(2) NOT NULL,
	"department" varchar(100) NOT NULL,
	"job_title" varchar(150) NOT NULL,
	"level" varchar(20) NOT NULL,
	"employment_status" varchar(20) DEFAULT 'active' NOT NULL,
	"hire_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_employees_org_employee_number" UNIQUE("organization_id","employee_number")
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"currency" varchar(3) PRIMARY KEY NOT NULL,
	"rate_to_usd" numeric(12, 6) NOT NULL,
	"as_of_date" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "salary_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" varchar(3) NOT NULL,
	"effective_date" date NOT NULL,
	"reason" varchar(30) NOT NULL,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_records" ADD CONSTRAINT "salary_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "salary_records" ADD CONSTRAINT "salary_records_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_org_entity" ON "audit_log" USING btree ("organization_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_employees_org_country" ON "employees" USING btree ("organization_id","country");--> statement-breakpoint
CREATE INDEX "idx_employees_org_department" ON "employees" USING btree ("organization_id","department");--> statement-breakpoint
CREATE INDEX "idx_employees_org_status" ON "employees" USING btree ("organization_id","employment_status");--> statement-breakpoint
CREATE INDEX "idx_salary_org_employee" ON "salary_records" USING btree ("organization_id","employee_id");--> statement-breakpoint
CREATE INDEX "idx_salary_org_employee_effective" ON "salary_records" USING btree ("organization_id","employee_id","effective_date");