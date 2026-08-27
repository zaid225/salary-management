import { zValidator } from "@hono/zod-validator";
import type { ZodType } from "zod/v4";

// One place that turns a zod failure into the shared error shape
// ({ error: { message, statusCode } }), so every route validates the same
// way instead of re-declaring the identical hook per file.
function hook(kind: "body" | "query") {
  return (result: { success: boolean; error?: { issues: { message?: string }[] } }, c: {
    json: (body: unknown, status: 400) => Response;
  }) => {
    if (!result.success) {
      const fallback = kind === "body" ? "Invalid request body" : "Invalid query";
      return c.json(
        { error: { message: result.error?.issues[0]?.message ?? fallback, statusCode: 400 } },
        400,
      );
    }
    return undefined;
  };
}

export function validateJson<T extends ZodType>(schema: T) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return zValidator("json", schema, hook("body") as any);
}

export function validateQuery<T extends ZodType>(schema: T) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return zValidator("query", schema, hook("query") as any);
}
