import type { Env } from "./env.js";

// `c.env` is the raw Cloudflare bindings object: our zod-validated string
// vars plus whatever binding objects wrangler.toml declares (Hyperdrive,
// KV, R2, ...). `Env` covers the strings; bindings are typed on top since
// they aren't strings zod can validate.
export type CloudflareBindings = Env & {
  HYPERDRIVE?: Hyperdrive;
};

export type Variables = { reqId: string; userId?: string };
export type AppBindings = { Bindings: CloudflareBindings; Variables: Variables };
