import type { Context, Next } from "hono";
import { verifyToken } from "@clerk/backend";
import type { AppBindings } from "../lib/context.js";

// Guards every mutating route unless it's an explicit public
// webhook/ingestion endpoint (api-security.md rule 2). Graceful
// degradation: Clerk unconfigured in dev -> clean 501, never a crash.
export async function requireAuth(
  c: Context<AppBindings>,
  next: Next,
): Promise<Response | void> {
  const secretKey = c.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return c.json(
      { error: { message: "Auth not configured", statusCode: 501 } },
      501,
    );
  }

  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return c.json({ error: { message: "Unauthorized", statusCode: 401 } }, 401);
  }

  try {
    const claims = await verifyToken(token, { secretKey });
    c.set("userId", claims.sub);
  } catch {
    // Never log the token itself - api-security.md rule 3.
    return c.json({ error: { message: "Invalid session token", statusCode: 401 } }, 401);
  }

  await next();
}
