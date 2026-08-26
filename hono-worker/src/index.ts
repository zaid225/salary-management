import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppBindings } from "./lib/context.js";
import { onError, notFound } from "./controllers/error.middleware.js";
import { healthRoutes } from "./routes/health.routes.js";
import { exampleRoutes } from "./routes/example.routes.js";
import { sessionsRoutes } from "./routes/sessions.routes.js";

const app = new Hono<AppBindings>();

// reqId for log correlation - error-handling-logging.md rule 2 (Hono has
// no built-in c.log, set this explicitly for every downstream log call).
app.use("*", async (c, next) => {
  c.set("reqId", crypto.randomUUID());
  await next();
});

// api-security.md rule 7: pin the origin in production instead of `*`.
app.use(
  "*",
  cors({
    origin: (origin, c) => {
      const allowed = c.env.ALLOWED_ORIGIN;
      if (c.env.NODE_ENV !== "production") return origin ?? "*";
      return allowed && origin === allowed ? origin : "";
    },
  }),
);

app.onError(onError);
app.notFound(notFound);

app.get("/", (c) => c.json({ name: "swades-hackathon-worker", status: "ok" }));

app.route("/api", healthRoutes);
app.route("/api", exampleRoutes);
app.route("/api", sessionsRoutes);

export default app;
