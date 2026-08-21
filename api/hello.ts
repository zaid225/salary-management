import type { VercelRequest, VercelResponse } from "@vercel/node";

// Zero-dependency diagnostic endpoint: no env, no DB, no app.ts.
// If this crashes, the problem is Vercel build/runtime config, not app code.
export default function handler(req: VercelRequest, res: VercelResponse): void {
  res.status(200).json({ message: "hello world", timestamp: new Date().toISOString() });
}
