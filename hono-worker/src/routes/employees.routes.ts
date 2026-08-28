import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppBindings } from "../lib/context.js";
import { requireAuth, resolveOrg, requireRole } from "../controllers/auth.middleware.js";
import { rateLimitByOrg } from "../controllers/rate-limit.middleware.js";
import { validateJson, validateQuery } from "../lib/validate.js";
import {
  AddSalaryRecordSchema,
  CreateEmployeeSchema,
  EmployeeListQuery,
  UpdateEmployeeSchema,
} from "../schemas/employee.schema.js";
import {
  listEmployees,
  getEmployee,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  addSalaryRecord,
  getEmployeeFacets,
} from "../controllers/employees.controller.js";
import { importEmployeesCsv, exportEmployeesCsv } from "../controllers/csv.controller.js";

export const employeesRoutes = new Hono<AppBindings>();

// Static segments are registered before /employees/:id so "export" and
// "import" can never be read as an employee id.
employeesRoutes.get(
  "/employees/export",
  requireAuth,
  resolveOrg,
  validateQuery(EmployeeListQuery),
  exportEmployeesCsv,
);

employeesRoutes.post(
  "/employees/import",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  // The heaviest single write this API does - bounded in both size and
  // rate (api-security.md rule 5, design spec §4).
  bodyLimit({
    maxSize: 5 * 1024 * 1024,
    onError: (c) => c.json({ error: { message: "CSV too large (max 5MB)", statusCode: 413 } }, 413),
  }),
  rateLimitByOrg(10, 3600),
  importEmployeesCsv,
);

// Registered before /employees/:id so "facets" is never read as an id.
employeesRoutes.get("/employees/facets", requireAuth, resolveOrg, getEmployeeFacets);

employeesRoutes.get("/employees", requireAuth, resolveOrg, validateQuery(EmployeeListQuery), listEmployees);
employeesRoutes.post(
  "/employees",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  validateJson(CreateEmployeeSchema),
  createEmployee,
);

employeesRoutes.get("/employees/:id", requireAuth, resolveOrg, getEmployee);
employeesRoutes.put(
  "/employees/:id",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  validateJson(UpdateEmployeeSchema),
  updateEmployee,
);
employeesRoutes.delete("/employees/:id", requireAuth, resolveOrg, requireRole("admin"), deleteEmployee);

employeesRoutes.post(
  "/employees/:id/salary",
  requireAuth,
  resolveOrg,
  requireRole("admin"),
  validateJson(AddSalaryRecordSchema),
  addSalaryRecord,
);
