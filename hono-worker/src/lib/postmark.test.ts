import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendInviteEmail } from "./postmark.js";
import { testEnv } from "../../test-utils/db.js";

describe("sendInviteEmail", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns false without calling Postmark when POSTMARK_SERVER_TOKEN is unset", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const ok = await sendInviteEmail(testEnv({ POSTMARK_SERVER_TOKEN: "" }), {
      to: "a@b.com",
      orgName: "ACME",
      inviterName: "Alice",
      acceptUrl: "https://app.example.com/accept-invite/abc",
    });

    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts to Postmark's API and returns true on 200", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const ok = await sendInviteEmail(testEnv({ POSTMARK_SERVER_TOKEN: "tok_123" }), {
      to: "a@b.com",
      orgName: "ACME",
      inviterName: "Alice",
      acceptUrl: "https://app.example.com/accept-invite/abc",
    });

    expect(ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.postmarkapp.com/email",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("returns false (never throws) when the fetch itself fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;

    const ok = await sendInviteEmail(testEnv({ POSTMARK_SERVER_TOKEN: "tok_123" }), {
      to: "a@b.com",
      orgName: "ACME",
      inviterName: "Alice",
      acceptUrl: "https://app.example.com/accept-invite/abc",
    });

    expect(ok).toBe(false);
  });
});
