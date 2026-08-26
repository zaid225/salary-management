import { config } from "dotenv";
import { vi } from "vitest";

config({ path: ".env.test" });

// Route tests authenticate with `Authorization: Bearer <clerkUserId>` -
// verifyToken just echoes the token back as `sub`, so tests never need a
// real Clerk session. Pass token "invalid" to exercise the 401 path.
vi.mock("@clerk/backend", () => ({
  verifyToken: vi.fn(async (token: string) => {
    if (token === "invalid") throw new Error("invalid token");
    return { sub: token };
  }),
}));
