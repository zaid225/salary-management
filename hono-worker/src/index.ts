import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppBindings } from "./lib/context.js";
import { onError, notFound } from "./controllers/error.middleware.js";
import { healthRoutes } from "./routes/health.routes.js";
import { exampleRoutes } from "./routes/example.routes.js";
import { webhooksRoutes } from "./routes/webhooks.routes.js";
import { organizationsRoutes } from "./routes/organizations.routes.js";
import { invitationsRoutes } from "./routes/invitations.routes.js";
import { membersRoutes } from "./routes/members.routes.js";
import { employeesRoutes } from "./routes/employees.routes.js";
import { analyticsRoutes } from "./routes/analytics.routes.js";
import { auditRoutes } from "./routes/audit.routes.js";
import { jobsRoutes } from "./routes/jobs.routes.js";
import { payrollRoutes } from "./routes/payroll.routes.js";
import { payrollRunsRoutes } from "./routes/payroll-runs.routes.js";
import { ewaRoutes } from "./routes/ewa.routes.js";
import { hrisRoutes } from "./routes/hris.routes.js";
import { taxRulesRoutes } from "./routes/tax-rules.routes.js";
import { treasuryRoutes } from "./routes/treasury.routes.js";

const app = new Hono<AppBindings>();

app.use("*", async (c, next) => {
  c.set("reqId", crypto.randomUUID());
  await next();
});

app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = c.env.FRONTEND_URL;
      if (c.env.NODE_ENV !== "production") return origin ?? "*";
      return allowed && origin === allowed ? origin : "";
    },
  }),
);

app.onError(onError);
app.notFound(notFound);

app.get("/", (c) => c.json({ name: "salary-management-api", status: "ok" }));

app.route("/api", healthRoutes);
app.route("/api", exampleRoutes);
app.route("/api", webhooksRoutes);
app.route("/api", organizationsRoutes);
app.route("/api", invitationsRoutes);
app.route("/api", membersRoutes);
app.route("/api", employeesRoutes);
app.route("/api", analyticsRoutes);
app.route("/api", auditRoutes);
app.route("/api", jobsRoutes);
app.route("/api", payrollRoutes);
app.route("/api", payrollRunsRoutes);
app.route("/api", ewaRoutes);
app.route("/api", hrisRoutes);
app.route("/api", taxRulesRoutes);
app.route("/api", treasuryRoutes);

export default app;
